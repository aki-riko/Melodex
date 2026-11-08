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
        // 同上:getLong 只认 Long,改用容错取值,否则"恢复上次进度"会静默变成 0。
        val positionMs = readMillisOption(call.data.opt("positionMs"))
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
        // 必须用 readMillisOption 而不是 call.getLong():
        // Capacitor 的 getLong 只认 `instanceof Long`,JSON 里的整数常被解析成
        // Integer、带小数的被解析成 Double,两者都会让 getLong 静默返回默认值 0,
        // 于是 seekTo(0) —— 表现正是"拖了还是从 0 开始"。详见 NativePlaybackModels.kt。
        val rawPosition = call.data.opt("positionMs")
        val requestedMs = readMillisOption(rawPosition)
        // 诊断:记录 JS 请求的目标位置 vs ExoPlayer 实际时长/当前位置。
        val beforeMs = player.currentPosition
        val durationMs = player.duration.takeUnless { it == C.TIME_UNSET || it < 0L } ?: 0L
        val seekable = try {
            player.isCurrentMediaItemSeekable
        } catch (_: Exception) {
            false
        }
        // rawType 记录桥接层实际给到的 Java 类型 —— 这是本次根因的判定依据,
        // 万一将来 Capacitor 改了 getLong 的实现,这行日志能立刻指出差异。
        Log.w(TAG, "seekTo requested=${requestedMs}ms duration=${durationMs}ms " +
            "before=${beforeMs}ms index=${player.currentMediaItemIndex} seekable=$seekable " +
            "rawType=${rawPosition?.javaClass?.simpleName ?: "null"}")
        player.seekTo(requestedMs)
        val appliedMs = player.currentPosition
        Log.w(TAG, "seekTo applied requested=${requestedMs}ms applied=${appliedMs}ms " +
            "delta=${appliedMs - requestedMs}ms")
        call.resolve(
            stateObject(player)
                .put("seekRequestedMs", requestedMs)
                .put("seekAppliedMs", appliedMs)
                .put("seekDurationMs", durationMs)
                .put("seekPositionMs", beforeMs)
                .put("seekable", seekable)
                .put("seekRawType", rawPosition?.javaClass?.simpleName ?: "null")
                .put("mediaItemType", currentItemFormatLabel(player)),
        )
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
    fun setSleepTimer(call: PluginCall) {
        val deadlineMs = readMillisOption(call.data.opt("deadlineMs"))
        val mode = try {
            sleepTimerMode(call.getString("mode", "immediate"))
        } catch (error: IllegalArgumentException) {
            call.reject(error.message ?: "睡眠定时模式无效", error)
            return
        }
        withController(call) { player ->
            try {
                PlaybackRuntime.sleepTimer?.set(deadlineMs, mode)
                    ?: error("睡眠定时器尚未初始化")
                call.resolve(stateObject(player))
            } catch (error: Exception) {
                call.reject(error.message ?: "设置睡眠定时失败", error)
            }
        }
    }

    @PluginMethod
    fun clearSleepTimer(call: PluginCall) = withController(call) {
        PlaybackRuntime.sleepTimer?.clear()
        call.resolve(stateObject(it))
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
        // seekable 随每次状态上报一起带出去:这样"这首歌能不能拖"一眼可见,
        // 不必再等到用户拖了才从 seekTo 里取一次。
        val seekable = try {
            player.isCurrentMediaItemSeekable
        } catch (_: Exception) {
            false
        }
        return JSObject()
            .put("currentIndex", player.currentMediaItemIndex.coerceAtLeast(0))
            .put("positionMs", player.currentPosition.coerceAtLeast(0L))
            .put("durationMs", duration)
            .put("isPlaying", player.isPlaying)
            .put("playWhenReady", player.playWhenReady)
            .put("playbackState", player.playbackState)
            .put("mediaItemCount", player.mediaItemCount)
            .put("seekable", seekable)
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

    // 当前正在播放的音频轨的实际容器/编解码摘要(如 "audio/flac"、"audio/mp4a|mp4a.40.2")。
    //
    // 为什么要记这个:seek 能否精确生效与**实际容器**强相关,而扩展名经常骗人。
    // 服务端日志只能看到 "某个 source/id + 某个字节偏移",看不到播放器把它解成了
    // 什么格式 —— 若 HTTP 的 Content-Type 与真实字节不一致(网易很常见),
    // ExoPlayer 会按错误的提取器建 seek map,于是"能播但拖不动"。
    // 取 currentTracks 里音频组第一个格式,而不是靠扩展名猜。
    private fun currentItemFormatLabel(player: Player): String {
        return try {
            for (group in player.currentTracks.groups) {
                if (group.type != C.TRACK_TYPE_AUDIO) continue
                for (index in 0 until group.length) {
                    val format = group.getTrackFormat(index)
                    val mime = format.sampleMimeType ?: continue
                    val codecs = format.codecs
                    return if (codecs.isNullOrBlank()) mime else "$mime|$codecs"
                }
            }
            ""
        } catch (_: Exception) {
            ""
        }
    }

    private companion object {
        const val EVENT_STATE = "playbackState"
        const val EVENT_ERROR = "playbackError"
        const val TAG = "MelodexNativePlayback"
        const val PROGRESS_INTERVAL_MS = 500L
        const val PREVIOUS_RESTART_THRESHOLD_MS = 3_000L
    }
}
