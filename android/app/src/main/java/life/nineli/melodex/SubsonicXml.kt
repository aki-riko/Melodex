package life.nineli.melodex

import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.InputStream
import javax.xml.XMLConstants
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
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = false
            isExpandEntityReferences = false
            setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeature("http://xml.org/sax/features/external-general-entities", false)
            setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        }
        return factory.newDocumentBuilder().parse(input)
    }

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
}
