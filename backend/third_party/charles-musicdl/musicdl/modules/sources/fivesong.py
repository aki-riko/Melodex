'''
Function:
    Implementation of FiveSongMusicClient: https://www.5song.xyz/index.html
Author:
    Zhenchao Jin
WeChat Official Account (微信公众号):
    Charles的皮卡丘
'''
import re
from bs4 import BeautifulSoup
from .base import BaseMusicClient
from rich.progress import Progress
from urllib.parse import urljoin, urlparse
from ..utils import legalizestring, usesearchheaderscookies, searchdictbykey, seconds2hms, SongInfo, QuarkParser


'''settings'''
QUALITY_RANK = {
    "DSD": 0, "WAV": 1, "FLAC": 2, "APE": 3, "ALAC": 4, "AAC": 5, "MP3": 6, "OGG": 7, "M4A": 8,
}


'''FiveSongMusicClient'''
class FiveSongMusicClient(BaseMusicClient):
    source = 'FiveSongMusicClient'
    def __init__(self, **kwargs):
        super(FiveSongMusicClient, self).__init__(**kwargs)
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
        self.search_size_per_page = min(self.search_size_per_source, 10)
        search_urls, page_size, count = [], self.search_size_per_page, 0
        while self.search_size_per_source > count:
            if int(count // page_size) + 1 == 1:
                search_urls.append(f'https://www.5song.xyz/search.html?keyword={keyword}')
            else:
                search_urls.append(f'https://www.5song.xyz/search.html?page={int(count // page_size) + 1}&keyword={keyword}')
            count += page_size
        # return
        return search_urls
    '''_parsesearchresultsfromhtml'''
    def _parsesearchresultsfromhtml(self, html_text: str):
        soup, base_url, search_results = BeautifulSoup(html_text, "html.parser"), "https://www.5song.xyz", []
        for li in soup.select("div.list ul > li"):
            a = li.select_one("a[href]")
            if not a: continue
            href = a.get("href", "").strip()
            detail_url = urljoin(base_url, href)
            title_el = a.select_one("div.con div.t h3")
            title = title_el.get_text(strip=True) if title_el else None
            formats = [s.get_text(strip=True) for s in a.select("div.con div.t span") if s.get_text(strip=True)]
            singer_el = a.select_one("div.singerNum div.singer")
            date_el = a.select_one("div.singerNum div.date")
            num_el = a.select_one("div.singerNum div.num")
            singer = singer_el.get_text(strip=True) if singer_el else None
            date = date_el.get_text(strip=True) if date_el else None
            num = num_el.get_text(strip=True) if num_el else None
            img = a.select_one("div.pic img")
            cover_url = urljoin(base_url, img.get("src")) if img and img.get("src") else None
            search_results.append({"title": title, "formats": formats, "singer": singer, "date": date, "num": num, "detail_url": detail_url, "cover_url": cover_url})
        return search_results
    '''_search'''
    @usesearchheaderscookies
    def _search(self, keyword: str = '', search_url: str = '', request_overrides: dict = None, song_infos: list = [], progress: Progress = None, progress_id: int = 0):
        # init
        request_overrides = request_overrides or {}
        base_url = "https://www.5song.xyz"
        def _guessformat(label: str) -> str | None:
            m = re.search(r"(DSD|WAV|FLAC|APE|ALAC|AAC|MP3|OGG|M4A)", label.upper())
            return m.group(1) if m else None
        def _sortbyaudioquality(link_list):
            def _keyfn(x: dict):
                fmt = _guessformat(x.get("label", ""))
                rank = QUALITY_RANK.get(fmt, 999)
                return (rank, fmt or "")
            return sorted(link_list, key=_keyfn)
        # successful
        try:
            # --search results
            resp = self.get(search_url, **request_overrides)
            resp.raise_for_status()
            search_results = self._parsesearchresultsfromhtml(resp.text)
            for search_result in search_results:
                # --download results
                if not isinstance(search_result, dict) or ('detail_url' not in search_result):
                    continue
                song_info = SongInfo(source=self.source)
                # ----fetch basic information
                try:
                    song_id = urlparse(search_result['detail_url']).path.strip('/').split('/')[-1].split('.')[0]
                    resp = self.get(search_result['detail_url'], **request_overrides)
                    resp.raise_for_status()
                    soup = BeautifulSoup(resp.text, "lxml")
                    quark_links = []
                    for li in soup.select("div.download ul li[data-url]"):
                        quark_url = (li.get("data-url") or "").strip()
                        a = li.select_one("a[href]")
                        label = a.get_text(" ", strip=True) if a else None
                        pc_download_href = a.get("href", "").strip() if a else None
                        pc_download_url = urljoin(base_url, pc_download_href) if pc_download_href else None
                        if "quark" in quark_url: quark_links.append({"label": label, "quark_url": quark_url, "pc_download_url": pc_download_url})
                    download_result = dict(quark_links=quark_links)
                except:
                    continue
                # ----parse from quark links
                sorted_items = _sortbyaudioquality(download_result['quark_links'])
                for item in sorted_items:
                    quark_url = item['quark_url']
                    try:
                        download_result['quark_parse_result'], download_url = QuarkParser.parsefromurl(quark_url, **self.quark_parser_config)
                        duration = searchdictbykey(download_result['quark_parse_result'], 'duration')
                        duration = [int(float(d)) for d in duration if int(float(d)) > 0]
                        if duration: duration = duration[0]
                        else: duration = 0
                        if not download_url: continue
                        download_url_status = self.quark_audio_link_tester.test(download_url, request_overrides)
                        download_url_status['probe_status'] = self.quark_audio_link_tester.probe(download_url, request_overrides)
                        ext = download_url_status['probe_status']['ext']
                        if ext == 'NULL': ext = 'mp3'
                        song_info = SongInfo(
                            source=self.source, download_url=download_url, download_url_status=download_url_status, raw_data={'search': search_result, 'download': download_result},
                            default_download_headers=self.quark_default_download_headers, ext=ext, file_size=download_url_status['probe_status']['file_size'], identifier=song_id, 
                            song_name=legalizestring(search_result.get('title', 'NULL'), replace_null_string='NULL'), album='NULL', duration_s=duration, duration=seconds2hms(duration),
                            singers=legalizestring(search_result.get('singer', 'NULL'), replace_null_string='NULL'),
                        )
                        if song_info.with_valid_download_url: break
                    except:
                        song_info = SongInfo(source=self.source)
                        continue
                if not song_info.with_valid_download_url: continue
                # --lyric results
                try:
                    lyrics_box = soup.select_one("div.viewCon div.text")
                    lyric_result = {'lyrics_box': str(lyrics_box)}
                    lines = [p.get_text(strip=True) for p in lyrics_box.select("p") if p.get_text(strip=True)]
                    lyric = "\n".join(lines)
                except:
                    lyric, lyric_result = 'NULL', {}
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