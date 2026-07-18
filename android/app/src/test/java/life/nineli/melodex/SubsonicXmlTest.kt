package life.nineli.melodex

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets

class SubsonicXmlTest {
    @Test
    fun searchResponsePreservesServerOrder() {
        val xml = """
            <subsonic-response status="ok" version="1.16.1">
              <searchResult3>
                <song id="first" title="服务端第一" artist="A" bitRate="999" suffix="flac" />
                <song id="second" title="服务端第二" artist="B" bitRate="128" suffix="mp3" />
                <song id="third" title="服务端第三" artist="C" bitRate="320" suffix="mp3" />
              </searchResult3>
            </subsonic-response>
        """.trimIndent()

        val songs = SubsonicXml.parseSongs(xml.byteInputStream())

        assertEquals(listOf("first", "second", "third"), songs.map(SubsonicSong::id))
        assertEquals(listOf("服务端第一", "服务端第二", "服务端第三"), songs.map(SubsonicSong::title))
    }

    @Test
    fun failedResponseReturnsServerMessage() {
        val xml = """
            <subsonic-response status="failed" version="1.16.1">
              <error code="40" message="Wrong username or password" />
            </subsonic-response>
        """.trimIndent()

        val error = assertThrows(SubsonicException::class.java) {
            SubsonicXml.requireSuccess(ByteArrayInputStream(xml.toByteArray()))
        }

        assertEquals("Wrong username or password", error.message)
    }

    @Test
    fun doctypeIsRejected() {
        val xml = """
            <!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
            <subsonic-response status="ok"><searchResult3><song id="x" title="&xxe;" /></searchResult3></subsonic-response>
        """.trimIndent()

        assertThrows(Exception::class.java) {
            SubsonicXml.parseSongs(xml.byteInputStream())
        }
    }

    @Test
    fun escapedAttributesAreDecoded() {
        val xml = """
            <subsonic-response status="ok" version="1.16.1">
              <searchResult3><song id="safe" title="A &amp; B" artist="C" /></searchResult3>
            </subsonic-response>
        """.trimIndent()

        val songs = SubsonicXml.parseSongs(xml.byteInputStream())

        assertEquals("A & B", songs.single().title)
    }

    @Test
    fun utf16ResponseIsRejected() {
        val xml = "<subsonic-response status=\"ok\" />"

        assertThrows(Exception::class.java) {
            SubsonicXml.requireSuccess(
                ByteArrayInputStream(xml.toByteArray(StandardCharsets.UTF_16LE)),
            )
        }
    }
}
