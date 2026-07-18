package life.nineli.melodex

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer

internal object PlaybackRuntime {
    @Volatile
    var cookieHeader: String = ""

    @Volatile
    var player: ExoPlayer? = null

    fun requestHeaders(): Map<String, String> = cookieRequestHeaders(cookieHeader)
}

@OptIn(UnstableApi::class)
internal class CookieAwareHttpDataSourceFactory : DataSource.Factory {
    override fun createDataSource(): DataSource = DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(false)
        .setDefaultRequestProperties(PlaybackRuntime.requestHeaders())
        .createDataSource()
}
