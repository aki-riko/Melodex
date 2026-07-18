package life.nineli.melodex

import androidx.media3.common.Player

internal data class NativeQueueItem(
    val id: String,
    val url: String,
    val title: String,
    val artist: String,
    val album: String,
    val coverUrl: String,
    val durationMs: Long,
) {
    companion object {
        fun create(
            id: String?,
            url: String?,
            title: String?,
            artist: String?,
            album: String?,
            coverUrl: String?,
            durationMs: Long?,
        ): NativeQueueItem {
            val normalizedURL = url.orEmpty().trim()
            require(normalizedURL.startsWith("https://")) { "播放地址必须使用 HTTPS" }
            return NativeQueueItem(
                id = id.orEmpty().trim().ifBlank { normalizedURL },
                url = normalizedURL,
                title = title.orEmpty().trim(),
                artist = artist.orEmpty().trim(),
                album = album.orEmpty().trim(),
                coverUrl = coverUrl.orEmpty().trim(),
                durationMs = durationMs?.coerceAtLeast(0L) ?: 0L,
            )
        }
    }
}

internal data class NativePlaybackMode(
    val repeatMode: Int,
    val shuffleEnabled: Boolean,
)

internal fun nativePlaybackMode(mode: String?): NativePlaybackMode = when (mode) {
    "order" -> NativePlaybackMode(Player.REPEAT_MODE_OFF, false)
    "repeat" -> NativePlaybackMode(Player.REPEAT_MODE_ONE, false)
    "shuffle" -> NativePlaybackMode(Player.REPEAT_MODE_ALL, true)
    else -> NativePlaybackMode(Player.REPEAT_MODE_ALL, false)
}

internal fun cookieRequestHeaders(cookie: String?): Map<String, String> =
    cookie?.trim()?.takeIf(String::isNotEmpty)?.let { mapOf("Cookie" to it) } ?: emptyMap()

internal fun firstCookieForURLs(urls: List<String>, lookup: (String) -> String?): String =
    urls.asSequence()
        .mapNotNull { url -> lookup(url)?.trim()?.takeIf(String::isNotEmpty) }
        .firstOrNull()
        .orEmpty()
