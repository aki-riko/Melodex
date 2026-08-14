'''
Function:
    Implementation of AppleMusicClient: https://music.apple.com/{geo}/new
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import os
import copy
import shutil
from .base import BaseMusicClient
from urllib.parse import urlencode
from rich.progress import Progress
from ..utils.appleutils import AppleMusicClientUtils, DownloadItem
from ..utils import touchdir, legalizestring, resp2json, seconds2hms, usesearchheaderscookies, safeextractfromdict, usedownloadheaderscookies, SongInfo, SongInfoUtils


'''AppleMusicClient'''
class AppleMusicClient(BaseMusicClient):
    source = 'AppleMusicClient'
    def __init__(self, **kwargs):
        super(AppleMusicClient, self).__init__(**kwargs)
        # headers setting
        self.default_search_headers = {
            "authorization": f"Bearer {self._fetchtoken()}",
            "accept": "*/*",
            "accept-language": "en-US",
            "origin": "https://music.apple.com",
            "priority": "u=1, i",
            "referer": "https://music.apple.com",
            "sec-ch-ua": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        }
        self.default_download_headers = copy.deepcopy(self.default_search_headers)
        self.default_headers = self.default_search_headers
        # account info (whether a VIP user)
        self.account_info = {}
        if not self.default_cookies or 'media-user-token' not in self.default_cookies: 
            self.logger_handle.warning(f'{self.source}.__init__ >>> "media-user-token" is not configured, so song downloads are restricted and only the preview portion of the track can be downloaded.')
        else:
            self.account_info = self._fetchaccountinfo()
        # init session
        self._initsession()
    '''_download'''
    @usedownloadheaderscookies
    def _download(self, song_info: SongInfo, request_overrides: dict = None, downloaded_song_infos: list = [], progress: Progress = None, song_progress_id: int = 0):
        if isinstance(song_info.download_url, str): return super()._download(song_info=song_info, request_overrides=request_overrides, downloaded_song_infos=downloaded_song_infos, progress=progress, song_progress_id=song_progress_id)
        request_overrides = request_overrides or {}
        try:
            touchdir(song_info.work_dir)
            tmp_dir = os.path.join(self.work_dir.replace(' ', ''), self.source.replace(' ', ''), song_info.identifier.replace(' ', '')) # replace space to avoid bugs
            touchdir(tmp_dir)
            download_item: DownloadItem = song_info.download_url
            download_item.final_path = os.path.join(tmp_dir, f'{song_info.identifier}.{song_info.ext}')
            progress.update(song_progress_id, total=1)
            progress.update(song_progress_id, description=f"{self.source}.download >>> {song_info.song_name} (Downloading)")
            AppleMusicClientUtils.download(download_item, work_dir=tmp_dir)
            shutil.move(download_item.final_path, song_info.save_path)
            progress.update(song_progress_id, total=os.path.getsize(song_info.save_path))
            progress.advance(song_progress_id, os.path.getsize(song_info.save_path))
            progress.update(song_progress_id, description=f"{self.source}.download >>> {song_info.song_name} (Success)")
            downloaded_song_infos.append(SongInfoUtils.fillsongtechinfo(copy.deepcopy(song_info), logger_handle=self.logger_handle, disable_print=self.disable_print))
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception as err:
            progress.update(song_progress_id, description=f"{self.source}.download >>> {song_info.song_name} (Error: {err})")
        return downloaded_song_infos
    '''_fetchtoken'''
    def _fetchtoken(self, request_overrides: dict = None):
        request_overrides = request_overrides or {}
        resp = self.get('https://music.apple.com', **request_overrides)
        resp.raise_for_status()
        home_page = resp.text
        index_js_uri_match = re.search(r"/(assets/index-legacy[~-][^/\"]+\.js)", home_page)
        index_js_uri = index_js_uri_match.group(1)
        resp = self.get(f"https://music.apple.com/{index_js_uri}", **request_overrides)
        resp.raise_for_status()
        index_js_page = resp.text
        token_match = re.search('(?=eyJh)(.*?)(?=")', index_js_page)
        token = token_match.group(1)
        return token
    '''_fetchaccountinfo'''
    def _fetchaccountinfo(self, request_overrides: dict = None):
        if self.account_info or (not self.default_cookies or 'media-user-token' not in self.default_cookies): return self.account_info
        request_overrides = request_overrides or {}
        resp = self.get('https://amp-api.music.apple.com/v1/me/account?meta=subscription', **request_overrides)
        resp.raise_for_status()
        account_info = resp2json(resp=resp)
        self.account_info = account_info
        return self.account_info
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        account_info = self._fetchaccountinfo(request_overrides=request_overrides)
        geo = safeextractfromdict(account_info, ['meta', 'subscription', 'storefront'], 'us')
        # search rules
        default_rule = {
            "groups": "song", "l": "en-US", "offset": "0", "term": keyword, "types": "activities,albums,apple-curators,artists,curators,editorial-items,music-movies,music-videos,playlists,record-labels,songs,stations,tv-episodes,uploaded-videos",
            "art[url]": "f", "extend": "artistUrl", "fields[albums]": "artistName,artistUrl,artwork,contentRating,editorialArtwork,editorialNotes,name,playParams,releaseDate,url,trackCount", "fields[artists]": "url,name,artwork",
            "format[resources]": "map", "include[editorial-items]": "contents", "include[songs]": "artists", "limit": "10", "omit[resource]": "autos", "platform": "web", "relate[albums]": "artists", "relate[editorial-items]": "contents",
            "relate[songs]": "albums", "types": "activities,albums,apple-curators,artists,curators,music-movies,music-videos,playlists,songs,stations,tv-episodes,uploaded-videos", "with": "lyrics,serverBubbles", 
        }
        default_rule.update(rule)
        geo = default_rule.pop('geo', geo)
        # construct search urls based on search rules
        base_url = f'https://amp-api-edge.music.apple.com/v1/catalog/{geo}/search?'
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            page_rule = copy.deepcopy(default_rule)
            page_rule['limit'] = page_size
            page_rule['offset'] = str(int(count // page_size) * page_size)
            search_urls.append(base_url + urlencode(page_rule))
            count += page_size
        # return
        return search_urls
    '''_fetchlicenseexchange'''
    def _fetchlicenseexchange(self, track_id: str, track_uri: str, challenge: str, key_system: str = "com.widevine.alpha", request_overrides: dict = None):
        request_overrides = request_overrides or {}
        json_data = {"challenge": challenge, "key-system": key_system, "uri": track_uri, "adamId": track_id, "isLibrary": False, "user-initiated": True}
        resp = self.post("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense", json=json_data, **request_overrides)
        resp.raise_for_status()
        license_exchange = resp2json(resp)
        return license_exchange
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = '', request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        # successful
        try:
            # --search results
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results: dict = resp2json(resp)['resources']['songs']
            for song_key, search_result in search_results.items():
                # --download results
                if not isinstance(search_result, dict) or ('id' not in search_result):
                    continue
                search_result['song_key'] = song_key
                song_info = SongInfo(source=self.source)
                # ----non-vip users
                if not self.default_cookies or 'media-user-token' not in self.default_cookies:
                    download_result = safeextractfromdict(search_result, ['attributes', 'previews', 0], {})
                    download_url: str = download_result.get('url')
                    if not download_url: continue
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides), 
                        ext=download_url.split('?')[0].split('.')[-1], raw_data={'search': search_result, 'download': download_result, 'lyric': {}}, lyric='NULL',
                    )
                    song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                    ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
                    if file_size and file_size != 'NULL': song_info.file_size = file_size
                    if not song_info.file_size: song_info.file_size = 'NULL'
                    if ext and ext != 'NULL': song_info.ext = ext
                # ----vip users
                else:
                    account_info = self._fetchaccountinfo(request_overrides=request_overrides)
                    geo = safeextractfromdict(account_info, ['meta', 'subscription', 'storefront'], 'us')
                    params = {"extend": "extendedAssetUrls", "include": "lyrics,albums"}
                    try:
                        resp = self.get(f'https://amp-api.music.apple.com/v1/catalog/{geo}/songs/{search_result["id"]}', params=params, **request_overrides)
                        resp.raise_for_status()
                        download_result = resp2json(resp=resp)
                        song_metadata = download_result['data'][0]
                        resp = self.post("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback", json={"salableAdamId": search_result["id"], "language": "en-US"}, **request_overrides)
                        resp.raise_for_status()
                        webplayback = resp2json(resp=resp)
                        download_result['webplayback'] = webplayback
                    except:
                        continue
                    download_item: DownloadItem = AppleMusicClientUtils.getsongdownloaditem(song_metadata=song_metadata, webplayback=webplayback, get_license_exchange_func=self._fetchlicenseexchange, request_overrides=request_overrides)
                    lyric_result, lyric = download_item.lyrics_results if download_item.lyrics_results else {}, download_item.lyrics.synced if download_item.lyrics.synced else 'NULL'
                    download_url, ext = download_item, download_item.stream_info.file_format.value
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_item.stream_info.audio_track.stream_url, request_overrides), 
                        ext=ext, raw_data={'search': search_result, 'download': download_result, 'lyric': lyric_result}, lyric=lyric,
                    )
                    song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(download_item.stream_info.audio_track.stream_url, request_overrides)
                    file_size = song_info.download_url_status['probe_status']['file_size']
                    if file_size and file_size != 'NULL': song_info.file_size = file_size
                    if not song_info.file_size: song_info.file_size = 'NULL'
                if not song_info.with_valid_download_url: continue
                song_info.update(
                    duration=seconds2hms(float(safeextractfromdict(search_result, ['attributes', 'durationInMillis'], '0')) / 1000),
                    song_name=legalizestring(safeextractfromdict(search_result, ['attributes', 'name'], 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(safeextractfromdict(search_result, ['attributes', 'artistName'], 'NULL'), replace_null_string='NULL'), 
                    album=legalizestring(safeextractfromdict(search_result, ['attributes', 'albumName'], 'NULL'), replace_null_string='NULL'),
                    identifier=search_result['id'],
                )
                # --append to song_infos
                song_infos.append(song_info)
                # --judgement for search_size
                if self.strict_limit_search_size_per_page and len(song_infos) >= self.search_size_per_page: break
            # --update progress
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Success)")
        # failure
        except Exception as err:
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Error: {err})")
        # return
        return song_infos