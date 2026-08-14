'''
Function:
    Implementation of TuneHubMusicClient: https://music-dl.sayqz.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import copy
from rich.progress import Progress
from urllib.parse import urlencode
from ..sources import BaseMusicClient
from ..utils import legalizestring, resp2json, usesearchheaderscookies, seconds2hms, extractdurationsecondsfromlrc, safeextractfromdict, cleanlrc, SongInfo


'''TuneHubMusicClient'''
class TuneHubMusicClient(BaseMusicClient):
    source = 'TuneHubMusicClient'
    ALLOWED_SITES = ['netease', 'kuwo', 'qq', 'kugou', 'migu'] # it seems kugou and migu are useless, recorded in 2026-01-18
    def __init__(self, **kwargs):
        self.allowed_music_sources = list(set(kwargs.pop('allowed_music_sources', TuneHubMusicClient.ALLOWED_SITES[:-2])))
        super(TuneHubMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        allowed_music_sources = copy.deepcopy(self.allowed_music_sources)
        # search rules
        default_rule = {'type': 'search', 'limit': self.search_size_per_page, 'page': '1', 'keyword': keyword}
        default_rule.update(rule)
        # construct search urls based on search rules
        base_url = 'https://music-dl.sayqz.com/api?'
        search_urls, page_size = [], self.search_size_per_page
        for source in TuneHubMusicClient.ALLOWED_SITES:
            if source not in allowed_music_sources: continue
            source_default_rule = copy.deepcopy(default_rule)
            source_default_rule['source'], count = source, 0
            while self.search_size_per_source > count:
                page_rule = copy.deepcopy(source_default_rule)
                page_rule['page'] = str(int(count // page_size) + 1)
                page_rule['limit'] = str(page_size)
                search_urls.append(base_url + urlencode(page_rule))
                count += page_size
        # return
        return search_urls
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = None, request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        # successful
        try:
            # --search results
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = resp2json(resp)['data']['results']
            for search_result in search_results:
                # --download results
                if (not isinstance(search_result, dict)) or ('id' not in search_result) or ('platform' not in search_result): continue
                song_info = SongInfo(source=self.source, root_source=search_result['platform'])
                for br in ['flac24bit', 'flac', '320k', '128k']:
                    params = {'br': br, 'id': search_result['id'], 'source': search_result['platform'], 'type': 'url'}
                    try:
                        resp = self.session.head('https://music-dl.sayqz.com/api?', timeout=10, params=params, allow_redirects=True, **request_overrides)
                        resp.raise_for_status()
                        download_url = resp.url
                    except:
                        continue
                    try:
                        resp = self.session.head(safeextractfromdict(search_result, ['pic'], None), timeout=10, allow_redirects=True, **request_overrides)
                        resp.raise_for_status()
                        cover_url = resp.url
                    except:
                        cover_url = safeextractfromdict(search_result, ['pic'], None) or ""
                    song_info = SongInfo(
                        raw_data={'search': search_result, 'download': {}, 'lyric': {}}, source=self.source, song_name=legalizestring(safeextractfromdict(search_result, ['name'], None)),
                        singers=legalizestring(safeextractfromdict(search_result, ['artist'], None)), album=legalizestring(safeextractfromdict(search_result, ['album'], None)),
                        ext=download_url.split('?')[0].split('.')[-1], file_size='NULL', identifier=search_result['id'], duration='-:-:-', lyric=None, cover_url=cover_url, 
                        download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides), root_source=search_result['platform'],
                    )
                    song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
                    song_info.file_size = song_info.download_url_status['probe_status']['file_size']
                    song_info.ext = song_info.download_url_status['probe_status']['ext'] if (song_info.download_url_status['probe_status']['ext'] and song_info.download_url_status['probe_status']['ext'] not in ('NULL', )) else song_info.ext
                    if song_info.with_valid_download_url: break
                # --lyric results
                try:
                    resp = self.get(search_result['lrc'], **request_overrides)
                    resp.raise_for_status()
                    lyric, lyric_result = cleanlrc(resp.text), {'lyric': resp.text}
                    song_info.duration_s = extractdurationsecondsfromlrc(lyric)
                    song_info.duration = seconds2hms(song_info.duration_s)
                except:
                    lyric_result, lyric = dict(), 'NULL'
                song_info.lyric = lyric
                song_info.raw_data['lyric'] = lyric_result
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