package life.nineli.melodex

import java.net.HttpURLConnection
import java.net.URL

class SubsonicClient(private val credentials: SubsonicCredentials) {
    fun ping() {
        openXml(SubsonicProtocol.endpointUrl(credentials, "ping")).use(SubsonicXml::requireSuccess)
    }

    fun search(query: String, songCount: Int = 50): List<SubsonicSong> {
        val url = SubsonicProtocol.endpointUrl(
            credentials = credentials,
            endpoint = "search3",
            extraParams = listOf(
                "query" to query,
                "songCount" to songCount.toString(),
                "artistCount" to "0",
                "albumCount" to "0",
            ),
        )
        return openXml(url).use(SubsonicXml::parseSongs)
    }

    fun streamUrl(songId: String): String = SubsonicProtocol.endpointUrl(
        credentials = credentials,
        endpoint = "stream",
        extraParams = listOf("id" to songId),
    )

    private fun openXml(url: String) = (URL(url).openConnection() as HttpURLConnection).run {
        requestMethod = "GET"
        connectTimeout = 15_000
        readTimeout = 90_000
        instanceFollowRedirects = true
        setRequestProperty("Accept", "application/xml")
        connect()
        val statusCode = responseCode
        if (statusCode !in 200..299) {
            disconnect()
            throw SubsonicException("服务器返回 HTTP $statusCode")
        }
        inputStream
    }
}
