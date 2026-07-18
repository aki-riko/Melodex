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
                recentlyDisconnectedRoutes = listOf(RecentlyDisconnectedRoute(headphones, 5_000L)),
                nowMs = 10_000L,
                evidenceWindowMs = 2_000L,
            ),
        )
    }

    @Test
    fun onlyPauseCapableMediaKeysAreDeferredForNoisyCorrelation() {
        assertTrue(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PAUSE))
        assertTrue(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertTrue(isDeferredMediaPauseKey(KeyEvent.KEYCODE_HEADSETHOOK))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_PLAY))
        assertFalse(isDeferredMediaPauseKey(KeyEvent.KEYCODE_MEDIA_NEXT))
    }
}
