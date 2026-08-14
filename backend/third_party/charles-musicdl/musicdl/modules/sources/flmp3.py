'''
Function:
    Implementation of FLMP3MusicClient: https://www.flmp3.pro/index.html
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
from bs4 import BeautifulSoup
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urljoin, urlparse
from ..utils import legalizestring, usesearchheaderscookies, seconds2hms, searchdictbykey, SongInfo, QuarkParser


'''settings'''
FORMAT_RANK = {
    "DSD": 100, "DSF": 100, "DFF": 100, "WAV": 95, "AIFF": 95, "FLAC": 90, "ALAC": 90, "APE": 88, "WV": 88,
    "OPUS": 70, "AAC": 65, "M4A": 65, "OGG": 60, "VORBIS": 60, "MP3": 50, "WMA": 45,
}


'''FLMP3MusicClient'''
class FLMP3MusicClient(BaseMusicClient):
    source = 'FLMP3MusicClient'
    def __init__(self, **kwargs):
        super(FLMP3MusicClient, self).__init__(**kwargs)
        assert self.quark_parser_config.get('cookies'), f'{self.source}.__init__ >>> "quark_parser_config" is not configured, so the songs cannot be downloaded.'
        self.default_search_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        }
        self.default_download_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        }
        self.default_headers = self.default_search_headers
        self._initsession()
    '''_constructsearchurls'''
    def _constructsearchurls(self, keyword: str, rule: dict = None, request_overrides: dict = None):
        # init
        rule, request_overrides = rule or {}, request_overrides or {}
        # construct search urls
        self.search_size_per_page = min(self.search_size_per_source, 12)
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            if int(count // page_size) + 1 == 1:
                search_urls.append(f'https://www.flmp3.pro/search.html?keyword={keyword}')
            else:
                search_urls.append(f'https://www.flmp3.pro/search.html?page={int(count // page_size) + 1}&keyword={keyword}')
            count += page_size
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup = BeautifulSoup(html_text, "html.parser")
        search_results, base_url = [], "https://flmp3.pro"
        for li in soup.select("div.list ul.flex.flex-wrap > li"):
            a = li.select_one("a")
            if not a: continue
            song_href = a.get("href", "")
            song_url = urljoin(base_url, song_href) if song_href else None
            title_el = li.select_one("div.con div.t h3")
            artist_el = li.select_one("div.con div.t p")
            date_el = li.select_one("div.con div.date")
            img_el = li.select_one("div.pic img")
            search_results.append({
                "song_url": song_url, "title": title_el.get_text(strip=True) if title_el else None, "artist": artist_el.get_text(strip=True) if artist_el else None,
                "date": date_el.get_text(strip=True) if date_el else None, "img_url": img_el.get("src") if img_el else None, "img_alt": img_el.get("alt") if img_el else None,
            })
        return search_results
    '''_parsesongdetailfordownloadpages'''
    def _parsesongdetailfordownloadpages(self, html_text: str):
        def _inferquality(text: str) -> str:
            t = text.upper()
            for q in FORMAT_RANK.keys():
                if q in t: return q
            return "UNKNOWN"
        soup, base_url, links = BeautifulSoup(html_text, "html.parser"), "https://www.flmp3.pro", []
        for a in soup.select(".btnBox a[href]"):
            text, href = a.get_text(strip=True), a["href"]
            links.append({"text": text, "quality": _inferquality(text), "rank": FORMAT_RANK.get(_inferquality(text), 0), "url": urljoin(base_url, href)})
        links_sorted = sorted(links, key=lambda x: x["rank"], reverse=True)
        song_id = urlparse(links_sorted[0]['url']).path.strip('/').split('/')[-1].split('.')[0]
        return {'links_sorted': links_sorted, 'song_id': song_id}
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
                if not isinstance(search_result, dict) or ('song_url' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                try:
                    resp = self.get(search_result['song_url'], **request_overrides)
                    resp.raise_for_status()
                    download_result = self._parsesongdetailfordownloadpages(resp.text)
                except:
                    continue
                for download_page_details in download_result['links_sorted']:
                    download_page_url = download_page_details['url']
                    try:
                        resp = self.get(download_page_url, **request_overrides)
                        resp.raise_for_status()
                        soup = BeautifulSoup(resp.text, "lxml")
                        a = soup.select_one("a.linkbtn[href]")
                        quark_download_url = a['href']
                        download_result['quark_parse_result'], download_url = QuarkParser.parsefromurl(quark_download_url, **self.quark_parser_config)
                        if not download_url: continue
                        duration = searchdictbykey(download_result['quark_parse_result'], 'duration')
                        duration = [int(float(d)) for d in duration if int(float(d)) > 0]
                        if duration: duration = duration[0]
                        else: duration = 0
                        download_url_status = self.quark_audio_link_tester.test(download_url, request_overrides)
                        download_url_status['probe_status'] = self.quark_audio_link_tester.probe(download_url, request_overrides)
                        ext = download_url_status['probe_status']['ext']
                        if ext == 'NULL': ext = 'mp3'
                    except:
                        continue
                    song_info = SongInfo(
                        source=self.source, download_url=download_url, download_url_status=download_url_status, default_download_headers=self.quark_default_download_headers,
                        raw_data={'search': search_result, 'download': download_result, 'lyric': {}}, lyric='NULL', file_size=download_url_status['probe_status']['file_size'],
                        ext=ext, duration_s=duration, duration=seconds2hms(duration), identifier=download_result.get('song_id'), album='NULL',
                        song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'),
                        singers=legalizestring(search_result.get('artist', 'NULL'), replace_null_string='NULL'), 
                    )
                    if song_info.with_valid_download_url: break
                if not song_info.with_valid_download_url: continue
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