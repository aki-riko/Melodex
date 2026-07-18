package life.nineli.melodex

data class SubsonicCredentials(
    val serverUrl: String,
    val username: String,
    val password: String,
)

data class SubsonicSong(
    val id: String,
    val title: String,
    val artist: String,
    val album: String,
    val durationSeconds: Int,
    val bitrateKbps: Int,
    val suffix: String,
)

class SubsonicException(message: String) : Exception(message)
