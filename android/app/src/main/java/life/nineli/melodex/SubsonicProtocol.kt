package life.nineli.melodex

import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom

object SubsonicProtocol {
    private const val API_VERSION = "1.16.1"
    private const val CLIENT_ID = "melodex-android"
    private val secureRandom = SecureRandom()

    fun normalizeServerUrl(raw: String): String {
        val value = raw.trim().trimEnd('/')
        val uri = runCatching { URI(value) }
            .getOrElse { throw IllegalArgumentException("服务器地址格式无效", it) }
        require(uri.scheme.equals("https", ignoreCase = true)) { "服务器地址必须使用 HTTPS" }
        require(!uri.host.isNullOrBlank()) { "服务器地址缺少主机名" }
        require(uri.rawQuery == null && uri.rawFragment == null) { "服务器地址不能包含查询参数或片段" }
        return value
    }

    fun endpointUrl(
        credentials: SubsonicCredentials,
        endpoint: String,
        extraParams: List<Pair<String, String>> = emptyList(),
        salt: String = randomSalt(),
    ): String {
        val baseUrl = normalizeServerUrl(credentials.serverUrl)
        val params = commonParams(credentials, salt) + extraParams
        val query = params.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }
        return "$baseUrl/rest/$endpoint.view?$query"
    }

    fun token(password: String, salt: String): String {
        val digest = MessageDigest.getInstance("MD5")
        return digest.digest((password + salt).toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun commonParams(credentials: SubsonicCredentials, salt: String) = listOf(
        "u" to credentials.username,
        "t" to token(credentials.password, salt),
        "s" to salt,
        "v" to API_VERSION,
        "c" to CLIENT_ID,
    )

    private fun randomSalt(): String {
        val bytes = ByteArray(12)
        secureRandom.nextBytes(bytes)
        return bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
