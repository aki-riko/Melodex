'''
Function:
    Implementation of SongInfoUtils
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import os
from pathlib import Path
from .data import SongInfo
from tinytag import TinyTag
from .lyric import WhisperLRC
from .logger import LoggerHandle
from .misc import seconds2hms, byte2mb


'''SongInfoUtils'''
class SongInfoUtils:
    '''fillsongtechinfo'''
    @staticmethod
    def fillsongtechinfo(song_info: SongInfo, logger_handle: LoggerHandle, disable_print: bool) -> SongInfo:
        path = Path(song_info.save_path)
        # correct file size
        size = path.stat().st_size
        song_info.file_size_bytes = size
        song_info.file_size = byte2mb(size=size)
        # tinytag parse
        try:
            tag = TinyTag.get(str(path))
        except Exception as err:
            logger_handle.warning(f'SongInfoUtils.fillsongtechinfo >>> {str(path)} (Err: {err})', disable_print=disable_print)
            return song_info
        if tag.duration:
            song_info.duration_s = int(round(tag.duration))
            song_info.duration = seconds2hms(tag.duration)
        if tag.bitrate:
            song_info.bitrate = int(round(tag.bitrate))
        if tag.samplerate:
            song_info.samplerate = int(tag.samplerate)
        if tag.channels:
            song_info.channels = int(tag.channels)
        if getattr(tag, "codec", None):
            song_info.codec = tag.codec
        elif getattr(tag, "extra", None) and isinstance(tag.extra, dict):
            song_info.codec = tag.extra.get("codec") or tag.extra.get("mime-type")
        # lyric
        if os.environ.get('ENABLE_WHISPERLRC', 'False').lower() == 'true' and ((not song_info.lyric) or (song_info.lyric == 'NULL')):
            lyric_result = WhisperLRC(model_size_or_path='small').fromfilepath(str(path))
            lyric = lyric_result['lyric']
            song_info.lyric = lyric
            song_info.raw_data['lyric'] = lyric_result
        # return
        return song_info