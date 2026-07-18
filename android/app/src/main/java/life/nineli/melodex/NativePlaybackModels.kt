package life.nineli.melodex

import androidx.media3.common.C
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

internal fun nextRecoverableIndex(
    currentIndex: Int,
    suggestedNextIndex: Int,
    mediaItemCount: Int,
    failedIndices: Set<Int>,
    allowWrap: Boolean,
): Int {
    if (mediaItemCount <= 0 || failedIndices.size >= mediaItemCount) return C.INDEX_UNSET
    if (suggestedNextIndex in 0 until mediaItemCount && suggestedNextIndex !in failedIndices) {
        return suggestedNextIndex
    }
    for (index in (currentIndex + 1).coerceAtLeast(0) until mediaItemCount) {
        if (index !in failedIndices) return index
    }
    if (allowWrap) {
        for (index in 0 until currentIndex.coerceAtMost(mediaItemCount)) {
            if (index !in failedIndices) return index
        }
    }
    return C.INDEX_UNSET
}

internal fun playWhenReadyReasonName(reason: Int): String = when (reason) {
    Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "user_request"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "audio_focus_loss"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "audio_becoming_noisy"
    Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "remote"
    Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "end_of_media_item"
    Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG -> "suppressed_too_long"
    else -> "unknown"
}

internal fun playerCommandName(command: Int): String = when (command) {
    Player.COMMAND_PLAY_PAUSE -> "play_pause"
    Player.COMMAND_STOP -> "stop"
    else -> "command"
}
