package life.nineli.melodex

import org.w3c.dom.Document
import org.w3c.dom.Element
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import java.io.InputStream
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import javax.xml.parsers.DocumentBuilderFactory

object SubsonicXml {
    fun parseSongs(input: InputStream): List<SubsonicSong> {
        val document = parseDocument(input)
        requireSuccess(document)
        val result = document.getElementsByTagName("searchResult3").item(0) as? Element
            ?: return emptyList()
        val songs = mutableListOf<SubsonicSong>()
        val children = result.childNodes
        for (index in 0 until children.length) {
            val element = children.item(index) as? Element ?: continue
            if (element.tagName != "song") continue
            songs += element.toSong()
        }
        return songs
    }

    fun requireSuccess(input: InputStream) {
        requireSuccess(parseDocument(input))
    }

    private fun parseDocument(input: InputStream): Document {
        val xml = decodeUtf8(input)
        require(!xml.contains('\u0000')) { "服务器返回了不支持的 XML 编码" }
        require(!DOCTYPE_PATTERN.containsMatchIn(xml)) { "服务器返回的 XML 包含被禁止的 DOCTYPE" }
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = false
            isExpandEntityReferences = false
        }
        val builder = factory.newDocumentBuilder().apply {
            setEntityResolver { _, _ -> throw SAXException("禁止解析外部 XML 实体") }
        }
        return builder.parse(InputSource(StringReader(xml)))
    }

    private fun decodeUtf8(input: InputStream): String = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(input.readBytes()))
        .toString()

    private fun requireSuccess(document: Document) {
        val root = document.documentElement
        if (root.getAttribute("status") == "ok") return
        val error = root.getElementsByTagName("error").item(0) as? Element
        val message = error?.getAttribute("message").orEmpty().ifBlank { "Subsonic 请求失败" }
        throw SubsonicException(message)
    }

    private fun Element.toSong() = SubsonicSong(
        id = requiredAttribute("id"),
        title = requiredAttribute("title"),
        artist = getAttribute("artist"),
        album = getAttribute("album"),
        durationSeconds = intAttribute("duration"),
        bitrateKbps = intAttribute("bitRate"),
        suffix = getAttribute("suffix"),
    )

    private fun Element.requiredAttribute(name: String): String =
        getAttribute(name).ifBlank { throw SubsonicException("歌曲缺少 $name 字段") }

    private fun Element.intAttribute(name: String): Int = getAttribute(name).toIntOrNull() ?: 0

    private val DOCTYPE_PATTERN = Regex("<!DOCTYPE", RegexOption.IGNORE_CASE)
}
