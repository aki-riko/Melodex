package life.nineli.melodex

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
}
