package life.nineli.melodex

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionResult

@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private data class PendingNoisyEvent(
        val observedAtMs: Long,
        val previousRoute: Set<AudioRouteDevice>,
    )

    private data class AudioRouteSnapshot(
        val devices: Set<AudioRouteDevice>,
        val isReliable: Boolean,
    )

    private var mediaSession: MediaSession? = null
    private lateinit var audioManager: AudioManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val platformMediaAudioAttributes = android.media.AudioAttributes.Builder()
        .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()
    private var receiverRegistered = false
    private var audioDeviceCallbackRegistered = false
    private var lastRoutedDevices = emptySet<AudioRouteDevice>()
    private val recentlyDisconnectedRoutes = ArrayDeque<RecentlyDisconnectedRoute>()
    private var deferredMediaPause: Runnable? = null
    private var pendingNoisyEvent: PendingNoisyEvent? = null
    private val clearPendingNoisyEvent = Runnable {
        pendingNoisyEvent = null
        Log.i(TAG, "expired pending noisy route evidence")
    }
    private val failedIndices = mutableSetOf<Int>()
    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != AudioManager.ACTION_AUDIO_BECOMING_NOISY) return
            handleAudioBecomingNoisy()
        }
    }
    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
            refreshAudioRoute("devices_added")
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
            val removed = removedDevices.mapTo(mutableSetOf()) { it.toRouteDevice() }
            val disconnectedAtMs = SystemClock.elapsedRealtime()
            val previousRoute = buildSet {
                addAll(lastRoutedDevices)
                pendingNoisyEvent?.previousRoute?.let(::addAll)
            }
            val routedDisconnects = routedPrivateDisconnects(
                previousRoute = previousRoute,
                removedDevices = removed,
                disconnectedAtMs = disconnectedAtMs,
            )
            recentlyDisconnectedRoutes += routedDisconnects
            pruneDisconnectedRoutes(disconnectedAtMs)
            Log.i(
                TAG,
                "audio devices removed=${routeDescription(removed)} " +
                    "recentRouted=${routeDescription(recentlyDisconnectedRoutes.mapTo(mutableSetOf()) { it.device })}",
            )
            val noisyEvent = pendingNoisyEvent
            if (routedDisconnects.isNotEmpty() && noisyEvent != null && isWithinEvidenceWindow(
                    eventAtMs = noisyEvent.observedAtMs,
                    nowMs = disconnectedAtMs,
                    evidenceWindowMs = NOISY_ROUTE_EVIDENCE_WINDOW_MS,
                )
            ) {
                pauseForValidatedNoisy("devices_removed")
            }
            mainHandler.postDelayed(
                { refreshAudioRoute("devices_removed_settled") },
                ROUTE_SETTLE_DELAY_MS,
            )
        }
    }
    private val recoveryListener = object : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            val player = mediaSession?.player
            val message = "playWhenReady=$playWhenReady reason=${playWhenReadyReasonName(reason)}($reason) " +
                "index=${player?.currentMediaItemIndex} positionMs=${player?.currentPosition} " +
                "state=${player?.playbackState} suppression=${player?.playbackSuppressionReason}"
            if (playWhenReady) Log.i(TAG, message) else Log.w(TAG, message)
        }

        override fun onPlaybackSuppressionReasonChanged(playbackSuppressionReason: Int) {
            Log.w(TAG, "suppressionReason=$playbackSuppressionReason")
        }

        override fun onTimelineChanged(timeline: Timeline, reason: Int) {
            if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) failedIndices.clear()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                failedIndices.clear()
                refreshAudioRoute("playing")
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.e(TAG, "player error code=${error.errorCode} message=${error.message}", error)
            val player = mediaSession?.player ?: return
            val currentIndex = player.currentMediaItemIndex
            if (currentIndex >= 0) failedIndices += currentIndex
            val nextIndex = nextRecoverableIndex(
                currentIndex = currentIndex,
                suggestedNextIndex = player.nextMediaItemIndex,
                mediaItemCount = player.mediaItemCount,
                failedIndices = failedIndices,
                allowWrap = player.repeatMode != Player.REPEAT_MODE_OFF,
            )
            if (nextIndex == C.INDEX_UNSET) {
                player.pause()
                return
            }
            player.seekTo(nextIndex, 0L)
            player.prepare()
            player.play()
        }
    }
    private val sessionCallback = object : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            Log.i(TAG, "controller connected ${controllerDescription(controller)}")
            return super.onConnect(session, controller)
        }

        @Suppress("OVERRIDE_DEPRECATION")
        override fun onPlayerCommandRequest(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            playerCommand: Int,
        ): Int {
            Log.w(
                TAG,
                "controller command=${playerCommandName(playerCommand)}($playerCommand) " +
                    controllerDescription(controller),
            )
            return SessionResult.RESULT_SUCCESS
        }

        override fun onMediaButtonEvent(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            intent: Intent,
        ): Boolean {
            val keyEvent = mediaButtonKeyEvent(intent) ?: return false
            if (!isDeferredMediaPauseKey(keyEvent.keyCode)) return false
            Log.w(
                TAG,
                "media button keyCode=${keyEvent.keyCode} action=${keyEvent.action} " +
                    "repeat=${keyEvent.repeatCount} playWhenReady=${session.player.playWhenReady} " +
                    controllerDescription(controller),
            )
            if (keyEvent.action != KeyEvent.ACTION_DOWN || keyEvent.repeatCount > 0) return true
            deferMediaPause(session.player)
            return true
        }

        override fun onPlayerInteractionFinished(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            playerCommands: Player.Commands,
        ) {
            Log.i(
                TAG,
                "controller interaction finished commands=$playerCommands playWhenReady=${session.player.playWhenReady} " +
                    controllerDescription(controller),
            )
        }
    }

    override fun onCreate() {
        super.onCreate()
        audioManager = checkNotNull(getSystemService(AudioManager::class.java)) {
            "系统音频服务不可用"
        }
        registerRouteMonitoring()
        refreshAudioRoute("service_created")
        val mediaSourceFactory = DefaultMediaSourceFactory(this)
            .setDataSourceFactory(CookieAwareHttpDataSourceFactory())
        val player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(mediaSourceFactory)
            .build()
            .apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                true,
            )
            setHandleAudioBecomingNoisy(false)
            setWakeMode(C.WAKE_MODE_LOCAL)
            addListener(recoveryListener)
        }
        PlaybackRuntime.player = player
        mediaSession = MediaSession.Builder(this, player)
            .setCallback(sessionCallback)
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        deferredMediaPause = null
        pendingNoisyEvent = null
        unregisterRouteMonitoring()
        mediaSession?.run {
            player.removeListener(recoveryListener)
            player.release()
            release()
        }
        failedIndices.clear()
        recentlyDisconnectedRoutes.clear()
        lastRoutedDevices = emptySet()
        PlaybackRuntime.player = null
        mediaSession = null
        super.onDestroy()
    }

    private fun controllerDescription(controller: MediaSession.ControllerInfo): String =
        "package=${controller.packageName} uid=${controller.uid} trusted=${controller.isTrusted} " +
            "verified=${controller.isPackageNameVerified} version=${controller.controllerVersion}"

    private fun registerRouteMonitoring() {
        val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(noisyReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(noisyReceiver, filter)
        }
        receiverRegistered = true
        audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler)
        audioDeviceCallbackRegistered = true
    }

    private fun unregisterRouteMonitoring() {
        if (audioDeviceCallbackRegistered) {
            audioManager.unregisterAudioDeviceCallback(audioDeviceCallback)
            audioDeviceCallbackRegistered = false
        }
        if (receiverRegistered) {
            unregisterReceiver(noisyReceiver)
            receiverRegistered = false
        }
    }

    private fun handleAudioBecomingNoisy() {
        val nowMs = SystemClock.elapsedRealtime()
        val previousRoute = buildSet {
            addAll(lastRoutedDevices)
            pendingNoisyEvent?.previousRoute?.let(::addAll)
        }
        val routeSnapshot = queryRoutedDevices()
        val currentRoute = routeSnapshot.devices
        pendingNoisyEvent = PendingNoisyEvent(
            observedAtMs = nowMs,
            previousRoute = previousRoute,
        )
        mainHandler.removeCallbacks(clearPendingNoisyEvent)
        mainHandler.postDelayed(clearPendingNoisyEvent, NOISY_ROUTE_EVIDENCE_WINDOW_MS)
        pruneDisconnectedRoutes(nowMs)
        val shouldPause = shouldPauseForNoisyRoute(
            currentRoute = currentRoute,
            currentRouteIsReliable = routeSnapshot.isReliable,
            recentlyDisconnectedRoutes = recentlyDisconnectedRoutes,
            nowMs = nowMs,
            evidenceWindowMs = NOISY_ROUTE_EVIDENCE_WINDOW_MS,
        )
        Log.w(
            TAG,
            "audio becoming noisy decision=${if (shouldPause) "pause" else "wait"} " +
                "current=${routeDescription(currentRoute)} previous=${routeDescription(lastRoutedDevices)} " +
                "recentDisconnected=${routeDescription(recentlyDisconnectedRoutes.mapTo(mutableSetOf()) { it.device })}",
        )
        lastRoutedDevices = currentRoute
        if (mediaSession?.player == null) return
        cancelDeferredMediaPause("noisy_received")
        if (shouldPause) {
            pauseForValidatedNoisy("current_or_recent_route")
        } else {
            Log.i(TAG, "noisy route awaiting device-removal evidence")
        }
    }

    private fun deferMediaPause(player: Player) {
        val nowMs = SystemClock.elapsedRealtime()
        val noisyEvent = pendingNoisyEvent
        if (noisyEvent != null && isWithinEvidenceWindow(
                eventAtMs = noisyEvent.observedAtMs,
                nowMs = nowMs,
                evidenceWindowMs = MEDIA_PAUSE_CORRELATION_WINDOW_MS,
            )
        ) {
            Log.i(TAG, "ignored media pause while noisy correlation is pending")
            return
        }
        cancelDeferredMediaPause("replaced")
        val task = Runnable {
            deferredMediaPause = null
            Log.w(TAG, "executing deferred media pause")
            if (player.playWhenReady) player.pause()
        }
        deferredMediaPause = task
        mainHandler.postDelayed(task, MEDIA_PAUSE_CORRELATION_WINDOW_MS)
        Log.i(TAG, "deferred media pause for noisy correlation")
    }

    private fun cancelDeferredMediaPause(reason: String): Boolean {
        val task = deferredMediaPause ?: return false
        mainHandler.removeCallbacks(task)
        deferredMediaPause = null
        Log.i(TAG, "cancelled deferred media pause reason=$reason")
        return true
    }

    private fun pauseForValidatedNoisy(reason: String) {
        mainHandler.removeCallbacks(clearPendingNoisyEvent)
        pendingNoisyEvent = null
        cancelDeferredMediaPause("validated_noisy")
        Log.w(TAG, "validated noisy route reason=$reason")
        val player = mediaSession?.player ?: return
        if (player.playWhenReady) player.pause()
    }

    private fun refreshAudioRoute(reason: String) {
        val route = queryRoutedDevices().devices
        if (route != lastRoutedDevices) {
            Log.i(
                TAG,
                "audio route reason=$reason previous=${routeDescription(lastRoutedDevices)} " +
                    "current=${routeDescription(route)}",
            )
            lastRoutedDevices = route
        }
    }

    private fun queryRoutedDevices(): AudioRouteSnapshot {
        if (hasReliableRouteQuery()) {
            val routed = audioManager.getAudioDevicesForAttributes(platformMediaAudioAttributes)
                .mapTo(mutableSetOf()) { it.toRouteDevice() }
            if (routed.isNotEmpty()) return AudioRouteSnapshot(routed, isReliable = true)
            Log.w(TAG, "getAudioDevicesForAttributes returned no route; using connected outputs")
        }
        val connectedOutputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .mapTo(mutableSetOf()) { it.toRouteDevice() }
        return AudioRouteSnapshot(connectedOutputs, isReliable = false)
    }

    private fun hasReliableRouteQuery(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    private fun pruneDisconnectedRoutes(nowMs: Long) {
        while (recentlyDisconnectedRoutes.firstOrNull()?.let {
                nowMs - it.disconnectedAtMs > NOISY_ROUTE_EVIDENCE_WINDOW_MS
            } == true
        ) {
            recentlyDisconnectedRoutes.removeFirst()
        }
    }

    private fun routeDescription(devices: Collection<AudioRouteDevice>): String = devices
        .sortedWith(compareBy(AudioRouteDevice::type, AudioRouteDevice::id))
        .joinToString(prefix = "[", postfix = "]") { "id=${it.id}/type=${it.type}" }

    private fun AudioDeviceInfo.toRouteDevice(): AudioRouteDevice = AudioRouteDevice(id = id, type = type)

    private fun mediaButtonKeyEvent(intent: Intent): KeyEvent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }

    private companion object {
        const val TAG = "MelodexPlayback"
        const val ROUTE_SETTLE_DELAY_MS = 250L
        const val NOISY_ROUTE_EVIDENCE_WINDOW_MS = 2_000L
        const val MEDIA_PAUSE_CORRELATION_WINDOW_MS = 250L
    }
}
