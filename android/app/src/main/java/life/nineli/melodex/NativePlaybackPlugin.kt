package life.nineli.melodex

import android.content.ComponentName
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

@CapacitorPlugin(name = "NativePlayback")
@OptIn(UnstableApi::class)
class NativePlaybackPlugin : Plugin() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = emitState(player)

        override fun onPlayerError(error: PlaybackException) {
            notifyListeners(
                EVENT_ERROR,
                JSObject()
                    .put("code", error.errorCode)
                    .put("message", error.message.orEmpty()),
            )
        }
    }

    private val progressTicker = object : Runnable {
        override fun run() {
            controller?.let(::emitState)
            mainHandler.postDelayed(this, PROGRESS_INTERVAL_MS)
        }
    }

    override fun load() {
        val token = SessionToken(getContext(), ComponentName(getContext(), PlaybackService::class.java))
        val future = MediaController.Builder(getContext(), token).buildAsync()
        controllerFuture = future
        future.addListener({
            try {
                controller = future.get().also { it.addListener(playerListener) }
                emitState(controller)
            } catch (error: Exception) {
                notifyControllerFailure(error)
            }
        }, ContextCompat.getMainExecutor(getContext()))
        mainHandler.post(progressTicker)
    }

    @PluginMethod
    fun setQueue(call: PluginCall) {
        val queue = try {
            parseQueue(call)
        } catch (error: Exception) {
            call.reject(error.message ?: "播放队列无效", error)
            return
        }
        val startIndex = (call.getInt("startIndex", 0) ?: 0).coerceIn(0, queue.lastIndex)
        val positionMs = (call.getLong("positionMs", 0L) ?: 0L).coerceAtLeast(0L)
        withController(call) { mediaController ->
            PlaybackRuntime.cookieHeader = firstCookieForURLs(queue.map(NativeQueueItem::url)) { url ->
                CookieManager.getInstance().getCookie(url)
            }
            mediaController.setMediaItems(queue.map(::toMediaItem), startIndex, positionMs)
            mediaController.prepare()
            call.resolve(stateObject(mediaController))
        }
    }

    @PluginMethod
    fun play(call: PluginCall) = withController(call) { it.play(); call.resolve(stateObject(it)) }

    @PluginMethod
    fun pause(call: PluginCall) = withController(call) {
        Log.w(TAG, "pause requested by Capacitor bridge")
        it.pause()
        call.resolve(stateObject(it))
    }

    @PluginMethod
    fun next(call: PluginCall) = withController(call) { player ->
        if (player.hasNextMediaItem()) player.seekToNextMediaItem()
        else if (player.mediaItemCount > 0) player.seekTo(0, 0L)
        player.play()
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun previous(call: PluginCall) = withController(call) { player ->
        if (player.currentPosition > PREVIOUS_RESTART_THRESHOLD_MS) player.seekTo(0L)
        else if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem()
        else if (player.mediaItemCount > 0) player.seekTo(player.mediaItemCount - 1, 0L)
        player.play()
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun seekTo(call: PluginCall) = withController(call) { player ->
        player.seekTo((call.getLong("positionMs", 0L) ?: 0L).coerceAtLeast(0L))
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun setPlaybackMode(call: PluginCall) = withController(call) { player ->
        val mode = nativePlaybackMode(call.getString("mode", "loop"))
        player.repeatMode = mode.repeatMode
        player.shuffleModeEnabled = mode.shuffleEnabled
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun setVolume(call: PluginCall) = withController(call) { player ->
        player.volume = (call.getFloat("volume", 1f) ?: 1f).coerceIn(0f, 1f)
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun setStopAfterCurrent(call: PluginCall) = withController(call) { player ->
        PlaybackRuntime.player?.setPauseAtEndOfMediaItems(call.getBoolean("enabled", false) ?: false)
        call.resolve(stateObject(player))
    }

    @PluginMethod
    fun getState(call: PluginCall) = withController(call) { call.resolve(stateObject(it)) }

    private fun parseQueue(call: PluginCall): List<NativeQueueItem> {
        val items = call.getArray("items") ?: error("缺少播放队列")
        require(items.length() > 0) { "播放队列不能为空" }
        return (0 until items.length()).map { index ->
            val item = items.getJSONObject(index)
            NativeQueueItem.create(
                id = item.optStringOrNull("id"),
                url = item.optStringOrNull("url"),
                title = item.optStringOrNull("title"),
                artist = item.optStringOrNull("artist"),
                album = item.optStringOrNull("album"),
                coverUrl = item.optStringOrNull("coverUrl"),
                durationMs = item.optLong("durationMs", 0L),
            )
        }
    }

    private fun toMediaItem(item: NativeQueueItem): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(item.title)
            .setArtist(item.artist)
            .setAlbumTitle(item.album)
            .setArtworkUri(item.coverUrl.takeIf(String::isNotBlank)?.let(Uri::parse))
            .build()
        return MediaItem.Builder()
            .setMediaId(item.id)
            .setUri(item.url)
            .setMediaMetadata(metadata)
            .build()
    }

    private fun withController(call: PluginCall, action: (MediaController) -> Unit) {
        mainHandler.post {
            val connected = controller
            if (connected != null) {
                try {
                    action(connected)
                } catch (error: Exception) {
                    call.reject(error.message ?: "播放器操作失败", error)
                }
                return@post
            }
            val future = controllerFuture
            if (future == null) {
                call.reject("播放器尚未初始化")
                return@post
            }
            future.addListener({
                try {
                    action(future.get())
                } catch (error: Exception) {
                    call.reject(error.message ?: "连接播放器失败", error)
                }
            }, ContextCompat.getMainExecutor(getContext()))
        }
    }

    private fun emitState(player: Player?) {
        if (player == null) return
        notifyListeners(EVENT_STATE, stateObject(player))
    }

    private fun stateObject(player: Player): JSObject {
        val duration = player.duration.takeUnless { it == C.TIME_UNSET || it < 0L } ?: 0L
        return JSObject()
            .put("currentIndex", player.currentMediaItemIndex.coerceAtLeast(0))
            .put("positionMs", player.currentPosition.coerceAtLeast(0L))
            .put("durationMs", duration)
            .put("isPlaying", player.isPlaying)
            .put("playWhenReady", player.playWhenReady)
            .put("playbackState", player.playbackState)
            .put("mediaItemCount", player.mediaItemCount)
    }

    private fun notifyControllerFailure(error: Exception) {
        notifyListeners(
            EVENT_ERROR,
            JSObject().put("code", -1).put("message", error.message.orEmpty()),
            true,
        )
    }

    override fun handleOnDestroy() {
        mainHandler.removeCallbacks(progressTicker)
        mainHandler.post {
            controller?.removeListener(playerListener)
            controllerFuture?.let(MediaController::releaseFuture)
            controller = null
            controllerFuture = null
        }
        super.handleOnDestroy()
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        optString(key, "").trim().takeIf(String::isNotEmpty)

    private companion object {
        const val EVENT_STATE = "playbackState"
        const val EVENT_ERROR = "playbackError"
        const val TAG = "MelodexNativePlayback"
        const val PROGRESS_INTERVAL_MS = 500L
        const val PREVIOUS_RESTART_THRESHOLD_MS = 3_000L
    }
}
