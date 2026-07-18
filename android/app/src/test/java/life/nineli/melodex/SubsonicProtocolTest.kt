package life.nineli.melodex

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SubsonicProtocolTest {
    @Test
    fun tokenMatchesSubsonicDocumentationExample() {
        assertEquals(
            "26719a1196d2a940705a59634eb18eab",
            SubsonicProtocol.token("sesame", "c19b2d"),
        )
    }

    @Test
    fun endpointUsesTokenAndNeverIncludesPlainPassword() {
        val credentials = SubsonicCredentials("https://music.example.test/", "kotori", "secret value")
        val url = SubsonicProtocol.endpointUrl(
            credentials,
            "search3",
            listOf("query" to "周杰伦 晴天"),
            salt = "abcdef",
        )

        assertTrue(url.startsWith("https://music.example.test/rest/search3.view?"))
        assertTrue(url.contains("u=kotori"))
        assertTrue(url.contains("query=%E5%91%A8%E6%9D%B0%E4%BC%A6+%E6%99%B4%E5%A4%A9"))
        assertFalse(url.contains("secret"))
        assertFalse(url.contains("p="))
    }

    @Test
    fun serverUrlRequiresHttpsAndNoQuery() {
        assertEquals("https://music.example.test", SubsonicProtocol.normalizeServerUrl(" https://music.example.test/ "))
        assertThrows(IllegalArgumentException::class.java) {
            SubsonicProtocol.normalizeServerUrl("http://music.example.test")
        }
        assertThrows(IllegalArgumentException::class.java) {
            SubsonicProtocol.normalizeServerUrl("https://music.example.test/?token=x")
        }
    }
}
