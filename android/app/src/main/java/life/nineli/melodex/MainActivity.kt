package life.nineli.melodex

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import java.util.concurrent.Executor
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val uiExecutor = Executor { command -> runOnUiThread(command) }
    private lateinit var settingsStore: SettingsStore
    private lateinit var songAdapter: SongListAdapter
    private var credentials: SubsonicCredentials? = null
    private var songs: List<SubsonicSong> = emptyList()
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null

    private lateinit var settingsPanel: LinearLayout
    private lateinit var searchPanel: LinearLayout
    private lateinit var serverUrlInput: EditText
    private lateinit var usernameInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var searchInput: EditText
    private lateinit var statusText: TextView
    private lateinit var settingsStatusText: TextView
    private lateinit var loadingIndicator: ProgressBar
    private lateinit var saveSettingsButton: Button
    private lateinit var playPauseButton: Button
    private lateinit var nowPlayingText: TextView

    private val playerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) = refreshPlayerUi()
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = refreshPlayerUi()
        override fun onPlaybackStateChanged(playbackState: Int) = refreshPlayerUi()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settingsStore = SettingsStore(this)
        bindViews()
        bindActions()
        connectController()
        requestNotificationPermission()
        showInitialScreen()
    }

    private fun bindViews() {
        settingsPanel = findViewById(R.id.settingsPanel)
        searchPanel = findViewById(R.id.searchPanel)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        usernameInput = findViewById(R.id.usernameInput)
        passwordInput = findViewById(R.id.passwordInput)
        searchInput = findViewById(R.id.searchInput)
        statusText = findViewById(R.id.statusText)
        settingsStatusText = findViewById(R.id.settingsStatusText)
        loadingIndicator = findViewById(R.id.loadingIndicator)
        saveSettingsButton = findViewById(R.id.saveSettingsButton)
        playPauseButton = findViewById(R.id.playPauseButton)
        nowPlayingText = findViewById(R.id.nowPlayingText)
        songAdapter = SongListAdapter(this)
        findViewById<ListView>(R.id.songList).adapter = songAdapter
    }

    private fun bindActions() {
        saveSettingsButton.setOnClickListener { saveAndTestSettings() }
        findViewById<Button>(R.id.searchButton).setOnClickListener { runSearch() }
        findViewById<Button>(R.id.openSettingsButton).setOnClickListener { showSettings() }
        findViewById<Button>(R.id.previousButton).setOnClickListener { controller?.seekToPreviousMediaItem() }
        findViewById<Button>(R.id.nextButton).setOnClickListener { controller?.seekToNextMediaItem() }
        playPauseButton.setOnClickListener { togglePlayback() }
        findViewById<ListView>(R.id.songList).setOnItemClickListener { _, _, position, _ ->
            playFromSearchResults(position)
        }
        searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId != EditorInfo.IME_ACTION_SEARCH) return@setOnEditorActionListener false
            runSearch()
            true
        }
    }

    private fun showInitialScreen() {
        credentials = settingsStore.load()
        val saved = credentials
        if (saved == null) {
            showSettings()
            return
        }
        serverUrlInput.setText(saved.serverUrl)
        usernameInput.setText(saved.username)
        passwordInput.setText(saved.password)
        showSearch()
    }

    private fun showSettings() {
        settingsPanel.visibility = View.VISIBLE
        searchPanel.visibility = View.GONE
    }

    private fun showSearch() {
        settingsPanel.visibility = View.GONE
        searchPanel.visibility = View.VISIBLE
        statusText.text = getString(R.string.status_server_order)
    }

    private fun saveAndTestSettings() {
        val candidate = try {
            readSettingsCandidate()
        } catch (error: Exception) {
            showSettingsStatus(error.message ?: getString(R.string.status_invalid_settings))
            return
        }
        setSettingsLoading(true, getString(R.string.status_testing_server))
        ioExecutor.execute { verifyAndSaveSettings(candidate) }
    }

    private fun readSettingsCandidate() = SubsonicCredentials(
        serverUrl = SubsonicProtocol.normalizeServerUrl(serverUrlInput.text.toString()),
        username = usernameInput.text.toString().trim().ifBlank {
            error(getString(R.string.status_enter_username))
        },
        password = passwordInput.text.toString().ifBlank {
            error(getString(R.string.status_enter_password))
        },
    )

    private fun verifyAndSaveSettings(candidate: SubsonicCredentials) {
        try {
            SubsonicClient(candidate).ping()
            settingsStore.save(candidate)
            credentials = candidate
            runOnUiThread {
                setSettingsLoading(false, getString(R.string.status_server_connected))
                showSearch()
            }
        } catch (error: Exception) {
            Log.e(TAG, "服务器验证失败", error)
            runOnUiThread {
                setSettingsLoading(false, error.message ?: getString(R.string.status_server_failed))
            }
        }
    }

    private fun runSearch() {
        val currentCredentials = credentials ?: return showSettings()
        val query = searchInput.text.toString().trim()
        if (query.isBlank()) {
            showStatus(getString(R.string.status_enter_query))
            return
        }
        setLoading(true, getString(R.string.status_searching))
        ioExecutor.execute {
            try {
                val result = SubsonicClient(currentCredentials).search(query)
                runOnUiThread {
                    songs = result
                    songAdapter.submitList(result)
                    setLoading(false, getString(R.string.status_result_count, result.size))
                }
            } catch (error: Exception) {
                Log.e(TAG, "搜索失败", error)
                runOnUiThread { setLoading(false, error.message ?: getString(R.string.status_search_failed)) }
            }
        }
    }

    private fun playFromSearchResults(startIndex: Int) {
        val mediaController = controller
        val currentCredentials = credentials
        if (mediaController == null || currentCredentials == null) {
            showStatus(getString(R.string.status_player_connecting))
            return
        }
        val client = SubsonicClient(currentCredentials)
        val mediaItems = songs.map { song -> song.toMediaItem(client) }
        mediaController.setMediaItems(mediaItems, startIndex, 0L)
        mediaController.prepare()
        mediaController.play()
    }

    private fun SubsonicSong.toMediaItem(client: SubsonicClient): MediaItem = MediaItem.Builder()
        .setMediaId(id)
        .setUri(client.streamUrl(id))
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .setAlbumTitle(album)
                .build(),
        )
        .build()

    private fun togglePlayback() {
        val mediaController = controller ?: return
        if (mediaController.isPlaying) mediaController.pause() else mediaController.play()
    }

    private fun connectController() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                controller = future.get().also { it.addListener(playerListener) }
                refreshPlayerUi()
            } catch (error: Exception) {
                Log.e(TAG, "连接播放器服务失败", error)
                showStatus(getString(R.string.status_player_failed))
            }
        }, uiExecutor)
    }

    private fun refreshPlayerUi() {
        val mediaController = controller
        val metadata = mediaController?.mediaMetadata
        val title = metadata?.title?.toString().orEmpty()
        val artist = metadata?.artist?.toString().orEmpty()
        nowPlayingText.text = if (title.isBlank()) {
            getString(R.string.not_playing)
        } else {
            getString(R.string.now_playing_format, title, artist)
        }
        playPauseButton.text = getString(if (mediaController?.isPlaying == true) R.string.pause else R.string.play)
    }

    private fun setLoading(loading: Boolean, message: String) {
        loadingIndicator.visibility = if (loading) View.VISIBLE else View.GONE
        showStatus(message)
    }

    private fun showStatus(message: String) {
        statusText.text = message
    }

    private fun setSettingsLoading(loading: Boolean, message: String) {
        saveSettingsButton.isEnabled = !loading
        showSettingsStatus(message)
    }

    private fun showSettingsStatus(message: String) {
        settingsStatusText.text = message
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_REQUEST_CODE)
    }

    override fun onDestroy() {
        controller?.removeListener(playerListener)
        controllerFuture?.let(MediaController::releaseFuture)
        controller = null
        ioExecutor.shutdownNow()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "MelodexAndroid"
        private const val NOTIFICATION_REQUEST_CODE = 1001
    }
}
