'''
Function:
    Implementation of XimalayaMusicClient: https://www.ximalaya.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import time
import copy
import base64
import binascii
from Crypto.Cipher import AES
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urlencode, urlparse
from ..utils import byte2mb, resp2json, seconds2hms, legalizestring, safeextractfromdict, usesearchheaderscookies, SongInfo


'''XimalayaMusicClient'''
class XimalayaMusicClient(BaseMusicClient):
    source = 'XimalayaMusicClient'
    def __init__(self, **kwargs):
        super(XimalayaMusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_decrypturl'''
    def _decrypturl(self, ciphertext: str):
        if not ciphertext: return ciphertext
        key = binascii.unhexlify("aaad3e4fd540b0f79dca95606e72bf93")
        ciphertext = base64.urlsafe_b64decode(ciphertext + "=" * (4 - len(ciphertext) % 4))
        cipher = AES.new(key, AES.MODE_ECB)
        plaintext = cipher.decrypt(ciphertext)
        plaintext = re.sub(r"[^\x20-\x7E]", "", plaintext.decode("utf-8"))
        return plaintext
    '''_validategdstudio'''
    def _validategdstudio(self, request_overrides: dict = None):
        request_overrides = request_overrides or {}
        try:
            resp = self.get('https://music-api.gdstudio.xyz/api.php?types=search&source=ximalaya&name=%E4%B8%89%E5%9B%BD&count=1&pages=1', timeout=10, **request_overrides)
            resp.raise_for_status()
            result = resp2json(resp=resp)
            assert isinstance(result, list) and (len(result) == 1)
            return True
        except:
            return False
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # if with cookies, use official apis
        if self.default_search_cookies:
            # --search rules
            default_rule = {
                'kw': keyword, 'page': 1, 'spellchecker': 'true', 'condition': 'relation', 'rows': self.search_size_per_page, 'device': 'iPhone', 
                'core': 'track', 'fq': '', 'paidFilter': 'false', 
            }
            default_rule.update(rule)
            # --construct search urls based on search rules
            base_url = 'https://www.ximalaya.com/revision/search/main?'
            search_urls, page_size, count = [], self.search_size_per_page, 0
            while self.search_size_per_source > count:
                page_rule = copy.deepcopy(default_rule)
                page_rule['rows'] = page_size
                page_rule['page'] = int(count // page_size) + 1
                search_urls.append(base_url + urlencode(page_rule))
                count += page_size
        # if without cookies, use third part apis
        else:
            # --search rules
            default_rule = {'types': 'search', 'source': 'ximalaya', 'name': keyword, 'count': self.search_size_per_page, 'pages': '1'}
            default_rule.update(rule)
            # --construct search urls based on search rules
            base_url = 'https://music-api.gdstudio.xyz/api.php?'
            search_urls, page_size, count = [], self.search_size_per_page, 0
            while self.search_size_per_source > count:
                page_rule = copy.deepcopy(default_rule)
                page_rule['count'] = page_size
                page_rule['pages'] = int(count // page_size) + 1
                search_urls.append(base_url + urlencode(page_rule))
                count += page_size
        # return
        return search_urls
    '''_parsegdstudioapi'''
    def _parsegdstudioapi(self, search_results, song_infos: list = [], request_overrides: dict = None):
        # init
        request_overrides = request_overrides or {}
        # parse
        for search_result in search_results:
            # --download results
            if (not isinstance(search_result, dict)) or ('id' not in search_result) or ('raw' not in search_result):
                continue
            song_info = SongInfo(source=self.source)
            for quality in ['play_path_64', 'play_path_aacv164', 'play_path_32', 'play_path_aacv224']:
                download_url: str = search_result['raw'].get(quality, '')
                if not download_url: continue
                song_info = SongInfo(
                    source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
                    raw_data={'search': search_result, 'download': {}, 'lyric': {}}, lyric='NULL', duration_s=search_result['raw'].get('duration', 0), 
                    duration=seconds2hms(search_result['raw'].get('duration', 0)), file_size='NULL', ext=download_url.split('?')[0].split('.')[-1],
                    song_name=legalizestring(search_result['raw'].get('title', 'NULL'), replace_null_string='NULL'), 
                    singers=legalizestring(search_result['raw'].get('nickname', 'NULL'), replace_null_string='NULL'), 
                    album=legalizestring(search_result['raw'].get('album_title', 'NULL'), replace_null_string='NULL'),
                    identifier=search_result['id'],
                )
                if song_info.with_valid_download_url: break
            if not song_info.with_valid_download_url: continue
            song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
            ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
            if file_size and file_size != 'NULL': song_info.file_size = file_size
            if ext and ext != 'NULL': song_info.ext = ext
            # --append to song_infos
            song_infos.append(song_info)
            # --judgement for search_size
            if self.strict_limit_search_size_per_page and len(song_infos) >= self.search_size_per_page: break
        # return
        return song_infos
    '''_parseofficialapi'''
    def _parseofficialapi(self, search_results, song_infos: list = [], request_overrides: dict = None):
        # init
        request_overrides = request_overrides or {}
        for search_result in search_results['data']['track']['docs']:
            # --download results
            if (not isinstance(search_result, dict)) or ('trackUrl' not in search_result):
                continue
            song_info = SongInfo(source=self.source)
            track_id = search_result.get('trackUrl').strip('/').split('/')[-1]
            for quality in [2, 1, 0]:
                params = {"device": "web", "trackId": track_id, "trackQualityLevel": quality}
                try:
                    resp = self.get(f"https://www.ximalaya.com/mobile-playpage/track/v3/baseInfo/{int(time.time() * 1000)}", params=params, **request_overrides)
                    resp.raise_for_status()
                    download_result = resp2json(resp=resp)
                    track_info = safeextractfromdict(download_result, ['trackInfo'], {})
                    if not track_info: continue
                except:
                    continue
                for encrypted_url in sorted(safeextractfromdict(track_info, ['playUrlList'], []), key=lambda x: int(x['fileSize']), reverse=True):
                    if not isinstance(encrypted_url, dict): continue
                    download_url = self._decrypturl(encrypted_url.get('url', ''))
                    if not download_url: continue
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=self.audio_link_tester.test(download_url, request_overrides),
                        raw_data={'search': search_result, 'download': download_result, 'lyric': {}}, lyric='NULL', duration_s=track_info.get('duration', 0), 
                        duration=seconds2hms(track_info.get('duration', 0)), file_size_bytes=encrypted_url.get('fileSize', 0), file_size=byte2mb(encrypted_url.get('fileSize', 0)),
                        ext=download_url.split('?')[0].split('.')[-1], identifier=track_id, song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'), 
                        singers=legalizestring(search_result.get('nickname', 'NULL'), replace_null_string='NULL'), 
                        album=legalizestring(safeextractfromdict(search_result, ['albumInfo', 'title'], ''), replace_null_string='NULL'), 
                    )
                    if song_info.with_valid_download_url: break
                if song_info.with_valid_download_url: break
            if not song_info.with_valid_download_url: continue
            song_info.download_url_status['probe_status'] = self.audio_link_tester.probe(song_info.download_url, request_overrides)
            ext, file_size = song_info.download_url_status['probe_status']['ext'], song_info.download_url_status['probe_status']['file_size']
            if file_size and file_size != 'NULL': song_info.file_size = file_size
            if ext and ext != 'NULL': song_info.ext = ext
            # --append to song_infos
            song_infos.append(song_info)
            # --judgement for search_size
            if self.strict_limit_search_size_per_page and len(song_infos) >= self.search_size_per_page: break
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
            search_results = resp2json(resp)
            # --parse based on selected API
            parsed_search_url = urlparse(search_url)
            if parsed_search_url.hostname in ['music-api.gdstudio.xyz']:
                self._parsegdstudioapi(search_results, song_infos=song_infos, request_overrides=request_overrides)
            else:
                self._parseofficialapi(search_results, song_infos=song_infos, request_overrides=request_overrides)
            # --update progress
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Success)")
        # failure
        except Exception as err:
            progress.update(progress_id, description=f"{self.source}.search >>> {search_url} (Error: {err})")
        # return
        return song_infos