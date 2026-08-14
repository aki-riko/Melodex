'''
Function:
    Implementation of TwoT58MusicClient: https://www.2t58.com/
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
import copy
from bs4 import BeautifulSoup
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urljoin, urlparse
from ..utils import legalizestring, usesearchheaderscookies, extractdurationsecondsfromlrc, seconds2hms, SongInfo, RandomIPGenerator


'''TwoT58MusicClient'''
class TwoT58MusicClient(BaseMusicClient):
    source = 'TwoT58MusicClient'
    def __init__(self, **kwargs):
        super(TwoT58MusicClient, self).__init__(**kwargs)
        self.default_search_headers = {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        }
        self.default_download_headers = {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # construct search urls
        self.search_size_per_page = min(self.search_size_per_source, 68)
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            if int(count // page_size) + 1 == 1:
                search_urls.append(f'https://www.2t58.com/so/{keyword}.html')
            else:
                search_urls.append(f'https://www.2t58.com/so/{keyword}/{int(count // page_size) + 1}.html')
            count += page_size
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup = BeautifulSoup(html_text, "lxml")
        search_results, base_url = [], 'https://www.2t58.com/'
        for a in soup.select(".play_list ul li .name a"):
            title = a.get_text(strip=True)
            href = a.get("href", "")
            song_id = urlparse(urljoin(base_url, href)).path.strip('/').split('/')[-1].split('.')[0]
            search_results.append({"title": title, "url": urljoin(base_url, href) if base_url else href, "path": href, "id": song_id})
        return search_results
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
            search_results = self._parsesearchresultsfromhtml(resp.text)
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('url' not in search_result) or ('id' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                for quality in ['flac', 'wav', '320']:
                    try:
                        headers = copy.deepcopy(self.default_headers)
                        RandomIPGenerator().addrandomipv4toheaders(headers=headers)
                        download_url = f"https://www.2t58.com/plug/down.php?ac=music&id={search_result['id']}&k={quality}"
                        download_url = self.get(download_url, allow_redirects=True, headers=headers, **request_overrides).url
                    except:
                        continue
                    download_url_status = self.audio_link_tester.test(download_url, request_overrides)
                    download_url_status['probe_status'] = self.audio_link_tester.probe(download_url, request_overrides)
                    ext = download_url_status['probe_status']['ext']
                    if ext == 'NULL': download_url.split('?')[0].split('.')[-1] or 'mp3'
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': {}},
                        ext=ext, file_size=download_url_status['probe_status']['file_size'], 
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
                # --lyric results
                try:
                    resp = self.get(f"https://www.2t58.com/plug/down.php?ac=music&lk=lrc&id={search_result['id']}", **request_overrides)
                    resp.raise_for_status()
                    lyric_result, lyric = {'lyric': resp.text.replace('[00:00.00]欢迎来访爱听音乐网 www.2t58.com\r\n', '')}, resp.text.replace('[00:00.00]欢迎来访爱听音乐网 www.2t58.com\r\n', '')
                    song_info.duration_s = extractdurationsecondsfromlrc(lyric)
                    song_info.duration = seconds2hms(song_info.duration_s)
                except:
                    lyric_result, lyric = dict(), 'NULL'
                song_info.raw_data['lyric'] = lyric_result
                artist = re.sub(r"\s*\[[^\]]*\]\s*$", "", search_result.get('title', 'NULL')).split("《", 1)[0].strip()
                song_name = re.search(r"《(.*?)》", re.sub(r"\s*\[[^\]]*\]\s*$", "", search_result.get('title', 'NULL'))).group(1).strip()
                song_info.update(dict(
                    lyric=lyric, song_name=legalizestring(song_name, replace_null_string='NULL'), 
                    singers=legalizestring(artist, replace_null_string='NULL'), album='NULL', identifier=search_result['id'],
                ))
                if not song_info.duration or song_info.duration == 'NULL': song_info.duration = '-:-:-'
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