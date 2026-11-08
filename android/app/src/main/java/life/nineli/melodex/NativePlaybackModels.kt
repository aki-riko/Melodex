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

// ---- 健壮的 JSON 数值取值(2026-11 修「手机拖动进度条无效」的直接根因) ----
//
// 事故链条(有实测证据,别再踩):
//   1. JS 传 `{ positionMs: value * 1000 }`,经 JSON.stringify 过桥;
//   2. Capacitor 的 PluginCall.getLong() 实现只认 `value instanceof Long`,
//      其它类型(Android 的 JSONTokener 常把小整数给成 Integer,浮点给成 Double)
//      **一律返回 defaultValue**;
//   3. 于是 `call.getLong("positionMs", 0L)` 得到 0 → `player.seekTo(0)` → 从头播;
//   4. 服务端于是只看到「从第一个音频帧开始」的 Range(570053),而不是中段的偏移。
// 这解释了用户原话「拖动进度是过去了,但是播放还是从 0 开始」——
// 是字面意义上的 0,不是"偏小"。
//
// 注意睡眠定时的 deadlineMs 也走 getLong,但它是 `Date.now()+n*60000`,
// 量级 1.7e12 必然被序列化成 Double/长整型以外的形态? 不 —— 它一旦成功过就说明
// 那条路径的数值恰好落在 Long 上。这里不做基于偶然的假设:所有 getLong 调用点
// 一律改用下面的容错取值,消除「取决于 JSON 解析器心情」的不确定性。
internal fun coerceToLongMs(value: Any?): Long? {
    return when (value) {
        null -> null
        is Long -> value
        is Int -> value.toLong()
        is Short -> value.toLong()
        is Byte -> value.toLong()
        is Double -> if (value.isFinite()) value.toLong() else null
        is Float -> if (value.isFinite()) value.toLong() else null
        is Number -> value.toLong()
        is String -> value.trim().toDoubleOrNull()?.takeIf { it.isFinite() }?.toLong()
        else -> null
    }
}

// 从 PluginCall 的原始 data 里取毫秒值,容忍 Integer/Double/String 等各种形态。
// fallback 只在"字段缺失或完全无法解析"时使用;解析出 0 是合法值(用户拖到最左)。
internal fun readMillisOption(raw: Any?, fallback: Long = 0L): Long =
    coerceToLongMs(raw)?.coerceAtLeast(0L) ?: fallback
