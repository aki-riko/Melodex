package life.nineli.melodex

import android.media.AudioDeviceInfo
import android.view.KeyEvent
import androidx.media3.common.C
import androidx.media3.common.Player
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePlaybackModelsTest {
    @Test
    fun playbackModeMatchesWebSemantics() {
        assertEquals(NativePlaybackMode(Player.REPEAT_MODE_OFF, false), nativePlaybackMode("order"))
        assertEquals(NativePlaybackMode(Player.REPEAT_MODE_ALL, false), nativePlaybackMode("loop"))
        assertEquals(NativePlaybackMode(Player.REPEAT_MODE_ONE, false), nativePlaybackMode("repeat"))
        assertEquals(NativePlaybackMode(Player.REPEAT_MODE_ALL, true), nativePlaybackMode("shuffle"))
    }

    @Test
    fun queueItemPreservesMetadataAndNormalizesDuration() {
        val item = NativeQueueItem.create(
            id = " qq:123 ",
            url = " https://music.example/music/download?stream=1 ",
            title = " 凝眸 ",
            artist = " 歌手 ",
            album = " 专辑 ",
            coverUrl = " https://music.example/cover ",
            durationMs = -10L,
        )
        assertEquals("qq:123", item.id)
        assertEquals("https://music.example/music/download?stream=1", item.url)
        assertEquals("凝眸", item.title)
        assertEquals("歌手", item.artist)
        assertEquals("专辑", item.album)
        assertEquals("https://music.example/cover", item.coverUrl)
        assertEquals(0L, item.durationMs)
    }

    @Test
    fun queueItemRejectsNonHttpsStreams() {
        assertThrows(IllegalArgumentException::class.java) {
            NativeQueueItem.create("id", "http://music.example/stream", "歌", "", "", "", 0L)
        }
    }

    @Test
    fun cookieHeadersUseFirstAvailableWebViewCookie() {
        val cookie = firstCookieForURLs(listOf("https://a.example", "https://b.example")) { url ->
            if (url.contains("b.example")) "session=real-cookie" else null
        }
        val headers = cookieRequestHeaders(cookie)
        assertEquals("session=real-cookie", headers["Cookie"])
        assertFalse(headers.isEmpty())
        assertTrue(cookieRequestHeaders(" ").isEmpty())
    }

    @Test
    fun failedTrackRecoveryUsesSuggestedQueueOrderAndStopsAfterExhaustion() {
        assertEquals(4, nextRecoverableIndex(2, 4, 6, setOf(2), allowWrap = true))
        assertEquals(3, nextRecoverableIndex(2, 2, 6, setOf(2), allowWrap = true))
        assertEquals(0, nextRecoverableIndex(5, C.INDEX_UNSET, 6, setOf(5), allowWrap = true))
        assertEquals(C.INDEX_UNSET, nextRecoverableIndex(5, C.INDEX_UNSET, 6, setOf(5), allowWrap = false))
        assertEquals(C.INDEX_UNSET, nextRecoverableIndex(0, 0, 2, setOf(0, 1), allowWrap = true))
    }

    @Test
    fun playbackDiagnosticsNamesPauseReasonsAndCommands() {
        assertEquals("user_request", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST))
        assertEquals("audio_focus_loss", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS))
        assertEquals("audio_becoming_noisy", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY))
        assertEquals("remote", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE))
        assertEquals("end_of_media_item", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM))
        assertEquals("suppressed_too_long", playWhenReadyReasonName(Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG))
        assertEquals("unknown", playWhenReadyReasonName(Int.MAX_VALUE))
        assertEquals("play_pause", playerCommandName(Player.COMMAND_PLAY_PAUSE))
        assertEquals("stop", playerCommandName(Player.COMMAND_STOP))
        assertEquals("command", playerCommandName(Int.MAX_VALUE))
    }

    @Test
    fun noisyBroadcastIsIgnoredWhenPlaybackIsAlreadyOnPhoneSpeaker() {
        val speaker = AudioRouteDevice(3, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        assertFalse(
            shouldPauseForNoisyRoute(
                currentRoute = setOf(speaker),
                currentRouteIsReliable = true,
                recentlyDisconnectedRoutes = emptyList(),
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun noisyBroadcastPausesWhilePrivateOutputIsStillRouted() {
        val headphones = AudioRouteDevice(8, AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
        assertTrue(
            shouldPauseForNoisyRoute(
                currentRoute = setOf(headphones),
                currentRouteIsReliable = true,
                recentlyDisconnectedRoutes = emptyList(),
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun noisyBroadcastPausesAfterRoutedPrivateOutputWasJustRemoved() {
        val speaker = AudioRouteDevice(3, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        val headphones = AudioRouteDevice(8, AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
        val recent = routedPrivateDisconnects(
            previousRoute = setOf(headphones),
            removedDevices = setOf(headphones),
            disconnectedAtMs = 9_500L,
        )
        assertTrue(
            shouldPauseForNoisyRoute(
                currentRoute = setOf(speaker),
                currentRouteIsReliable = true,
                recentlyDisconnectedRoutes = recent,
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun unrelatedOrStaleDeviceRemovalDoesNotValidateNoisyBroadcast() {
        val speaker = AudioRouteDevice(3, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        val headphones = AudioRouteDevice(8, AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
        assertTrue(
            routedPrivateDisconnects(
                previousRoute = setOf(speaker),
                removedDevices = setOf(headphones),
                disconnectedAtMs = 9_500L,
            ).isEmpty(),
        )
        assertFalse(
            shouldPauseForNoisyRoute(
                currentRoute = setOf(speaker),
                currentRouteIsReliable = true,
                recentlyDisconnectedRoutes = listOf(RecentlyDisconnectedRoute(headphones, 5_000L)),
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun onlyPauseCapableMediaKeysAreDeferredForNoisyCorrelation() {
        assertTrue(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PAUSE))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_HEADSETHOOK))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PLAY))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_NEXT))
    }

    @Test
    fun connectedOutputsAreNotTreatedAsActualRoutesOnOlderAndroid() {
        val headphones = AudioRouteDevice(8, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
        assertFalse(
            shouldPauseForNoisyRoute(
                currentRoute = setOf(headphones),
                currentRouteIsReliable = false,
                recentlyDisconnectedRoutes = emptyList(),
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun lateDeviceRemovalCanValidateAnEarlierNoisyBroadcast() {
        val headphones = AudioRouteDevice(8, AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
        val disconnected = routedPrivateDisconnects(
            previousRoute = setOf(headphones),
            removedDevices = setOf(headphones),
            disconnectedAtMs = 10_100L,
        )
        assertTrue(isWithinEvidenceWindow(10_000L, 10_100L, 2_000L))
        assertTrue(
            shouldPauseForNoisyRoute(
                currentRoute = emptySet(),
                currentRouteIsReliable = false,
                recentlyDisconnectedRoutes = disconnected,
                nowMs = 10_100L,
                evidenceWindowMs = 2_000L,
            ),
        )
        assertFalse(isWithinEvidenceWindow(10_000L, 9_999L, 2_000L))
        assertFalse(isWithinEvidenceWindow(10_000L, 12_001L, 2_000L))
    }

    // ---- 2026-11 修「手机拖动进度条无效」的核心回归 ----
    //
    // 真因:Capacitor 的 PluginCall.getLong() 只认 `value instanceof Long`,
    // 其它类型(JSON 整数常被解析成 Integer,浮点被解析成 Double)**一律返回默认值**。
    // 因此 `call.getLong("positionMs", 0L)` 会得到 0 → player.seekTo(0) → 从头播,
    // 用户看到的就是「拖了还是从 0 开始」,服务端也只收到第一个音频帧处的 Range。
    // 这些用例锁死"任何数值形态都必须被正确换算",防止再退回类型敏感的实现。
    @Test
    fun millisOptionAcceptsEveryNumericShapeTheBridgeMaySend() {
        // 最关键的四个:Int(JSON 小整数)、Long、Double(带小数或 .0)、数字字符串。
        assertEquals(120_000L, readMillisOption(120_000))
        assertEquals(120_000L, readMillisOption(120_000L))
        assertEquals(120_000L, readMillisOption(120_000.0))
        assertEquals(120_000L, readMillisOption("120000"))

        // 拖动步进是 0.5s → 500ms,浮点必须能落到毫秒。
        assertEquals(120_500L, readMillisOption(120_500.0))
        // 非整毫秒向下取整(ExoPlayer 只接受 Long,不能四舍五入到下一毫秒导致越界)。
        assertEquals(120_500L, readMillisOption(120_500.6))

        assertEquals(180_000L, readMillisOption(180_000.0f))
        assertEquals(7L, readMillisOption(7.toShort()))
        assertEquals(9L, readMillisOption(9.toByte()))
    }

    @Test
    fun millisOptionFallsBackOnlyWhenValueIsTrulyUnusable() {
        // 缺失/无法解析才用 fallback;注意 0 是合法值(用户拖到最左),不能被当成缺失。
        assertEquals(0L, readMillisOption(null))
        assertEquals(0L, readMillisOption("not-a-number"))
        assertEquals(5_000L, readMillisOption(null, fallback = 5_000L))
        assertEquals(5_000L, readMillisOption("abc", fallback = 5_000L))

        // 0 必须原样返回,而不是被 fallback 顶掉。
        assertEquals(0L, readMillisOption(0))
        assertEquals(0L, readMillisOption(0.0))
        assertEquals(0L, readMillisOption("0", fallback = 5_000L))
    }

    @Test
    fun millisOptionRejectsNonFiniteAndNegativeValues() {
        // NaN/Infinity 转 Long 在 JVM 上是 0 或 Long.MAX,必须显式挡掉。
        assertEquals(0L, readMillisOption(Double.NaN))
        assertEquals(0L, readMillisOption(Double.POSITIVE_INFINITY))
        assertEquals(0L, readMillisOption(Float.NEGATIVE_INFINITY))
        // 负值钳到 0:seekTo 不接受负位置。
        assertEquals(0L, readMillisOption(-1_000))
        assertEquals(0L, readMillisOption(-1_000.0))
    }

    @Test
    fun coerceToLongMsDistinguishesMissingFromZero() {
        // 这两者必须可区分:null = 字段缺失,0 = 明确的 0 毫秒。
        assertEquals(null, coerceToLongMs(null))
        assertEquals(0L, coerceToLongMs(0))
        assertEquals(0L, coerceToLongMs(0.0))
    }
}
