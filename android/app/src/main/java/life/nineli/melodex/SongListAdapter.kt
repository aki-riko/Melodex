package life.nineli.melodex

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.TextView

class SongListAdapter(private val context: Context) : BaseAdapter() {
    private val inflater = LayoutInflater.from(context)
    private var songs: List<SubsonicSong> = emptyList()

    fun submitList(items: List<SubsonicSong>) {
        songs = items.toList()
        notifyDataSetChanged()
    }

    override fun getCount(): Int = songs.size

    override fun getItem(position: Int): SubsonicSong = songs[position]

    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
        val view = convertView ?: inflater.inflate(R.layout.song_row, parent, false)
        val song = getItem(position)
        view.findViewById<TextView>(R.id.songTitle).text =
            context.getString(R.string.song_row_title, position + 1, song.title)
        view.findViewById<TextView>(R.id.songMeta).text = song.metadataText()
        return view
    }

    private fun SubsonicSong.metadataText(): String {
        val quality = when {
            suffix.equals("flac", ignoreCase = true) -> context.getString(R.string.quality_lossless)
            bitrateKbps > 0 -> context.getString(R.string.quality_bitrate, bitrateKbps)
            else -> suffix.uppercase().ifBlank { context.getString(R.string.quality_unknown) }
        }
        return listOf(artist, album, quality).filter(String::isNotBlank).joinToString(" · ")
    }
}
