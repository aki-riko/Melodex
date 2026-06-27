package web

// Subsonic facade —— id 编解码 + search3(联网搜索 + 验活)。
//
// id 编解码:Subsonic 的 id 是不透明字符串,客户端拿它来 stream/getCoverArt。
// 在线源的歌曲需要 source+id+extra 才能解析播放,但 extra 可能较大且含特殊字符,
// 不适合全塞进 id。策略:
//   - id 用 base64url 编码核心字段(source|id|name|artist|album),无状态可解
//   - extra(源特有元数据)存进进程内映射表,id 里带一个短 key 指向它
//
// 映射表用 LRU 上限防内存膨胀;命中失败时降级用 id 里的核心字段(多数源够用)。

import (
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guohuiyuan/go-music-dl/core"
	"github.com/guohuiyuan/music-lib/model"
)

// onlineSongIDPrefix 标识这是「在线源歌曲」id(区别于本地曲库 id)。
const onlineSongIDPrefix = "ts1:"

// localSongIDPrefix 标识本地曲库歌曲 id。
const localSongIDPrefix = "loc:"

// songExtraStore 存在线歌曲的 extra 元数据,key 由 source+id 派生。
// 有上限,超出后清空重建(简单防膨胀;extra 丢失时降级用核心字段)。
type songExtraStore struct {
	mu      sync.Mutex
	data    map[string]map[string]string
	maxSize int
}

var globalExtraStore = &songExtraStore{
	data:    make(map[string]map[string]string),
	maxSize: 5000,
}

// coverURLStore 存「艺人名/专辑名 → 在线封面 URL」映射,供 getCoverArt 解析
// artist:/album: 合成 id 的封面(音流忽略响应里的 coverArt 字段,直接拿
// artist/album 的 id 当封面 id 请求,故合成 id 必须能反查到封面 URL)。
type coverURLStore struct {
	mu      sync.Mutex
	data    map[string]string
	maxSize int
}

var globalCoverStore = &coverURLStore{
	data:    make(map[string]string),
	maxSize: 5000,
}

func (s *coverURLStore) put(key, coverURL string) {
	if key == "" || coverURL == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data) >= s.maxSize {
		s.data = make(map[string]string)
	}
	// 只记首次(搜索结果已按相关性排序,首个通常最具代表性)。
	if _, ok := s.data[key]; !ok {
		s.data[key] = coverURL
	}
}

func (s *coverURLStore) get(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data[key]
}

// coverStoreKey 由类型(artist/album)+名称派生 coverURLStore 的键。
func coverStoreKey(kind, name string) string {
	return kind + "\x00" + name
}

// resolveSyntheticCoverURL 解析 artist:/album: 合成 id(可能带音流加的
// ar-/al- 前缀)对应的在线封面 URL;解不出返回空串。
func resolveSyntheticCoverURL(id string) string {
	s := strings.TrimSpace(id)
	// 音流给 getCoverArt 的 id 会加 ar-/al- 前缀,先剥离。
	s = strings.TrimPrefix(s, "ar-")
	s = strings.TrimPrefix(s, "al-")
	var kind string
	switch {
	case strings.HasPrefix(s, "artist:"):
		kind = "artist"
		s = strings.TrimPrefix(s, "artist:")
	case strings.HasPrefix(s, "album:"):
		kind = "album"
		s = strings.TrimPrefix(s, "album:")
	default:
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	return globalCoverStore.get(coverStoreKey(kind, string(raw)))
}

func (s *songExtraStore) put(key string, extra map[string]string) {
	if len(extra) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.data) >= s.maxSize {
		// 超上限直接清空重建(避免无界增长;最坏情况下次播放重搜即可恢复)。
		s.data = make(map[string]map[string]string)
	}
	cloned := make(map[string]string, len(extra))
	for k, v := range extra {
		cloned[k] = v
	}
	s.data[key] = cloned
}

func (s *songExtraStore) get(key string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.data[key]; ok {
		return v
	}
	return nil
}

// extraKey 由 source+id 派生,作为 extra 映射表的键。
func extraKey(source, id string) string {
	return source + "\x00" + id
}

// encodeOnlineSongID 把在线源歌曲编码成 Subsonic id。
// 每个字段独立 base64url 编码后用 "." 连接(. 不在 base64url 字母表中,
// 故字段内含任意字节都不会破坏分隔)。extra 另存映射表。
func encodeOnlineSongID(song model.Song) string {
	globalExtraStore.put(extraKey(song.Source, song.ID), song.Extra)
	fields := []string{song.Source, song.ID, song.Name, song.Artist, song.Album, song.Cover}
	encoded := make([]string, len(fields))
	for i, f := range fields {
		encoded[i] = base64.RawURLEncoding.EncodeToString([]byte(f))
	}
	return onlineSongIDPrefix + strings.Join(encoded, ".")
}

// decodeOnlineSongID 还原在线源歌曲(含从映射表取回 extra)。
// 返回 ok=false 表示这不是合法的在线源 id。
func decodeOnlineSongID(id string) (model.Song, bool) {
	if !strings.HasPrefix(id, onlineSongIDPrefix) {
		return model.Song{}, false
	}
	tokens := strings.Split(strings.TrimPrefix(id, onlineSongIDPrefix), ".")
	if len(tokens) < 6 {
		return model.Song{}, false
	}
	fields := make([]string, 6)
	for i := 0; i < 6; i++ {
		raw, err := base64.RawURLEncoding.DecodeString(tokens[i])
		if err != nil {
			return model.Song{}, false
		}
		fields[i] = string(raw)
	}
	song := model.Song{
		Source: fields[0],
		ID:     fields[1],
		Name:   fields[2],
		Artist: fields[3],
		Album:  fields[4],
		Cover:  fields[5],
	}
	song.Extra = globalExtraStore.get(extraKey(song.Source, song.ID))
	return song, true
}

// encodeLocalSongID 把本地曲库的 track.ID(本身已是 base64url 的相对路径)
// 再包一层 loc: 前缀编码成 Subsonic id,与在线源 id 区分。
func encodeLocalSongID(trackID string) string {
	return localSongIDPrefix + base64.RawURLEncoding.EncodeToString([]byte(trackID))
}

// decodeLocalSongID 还原本地曲库 track.ID(可直接传给 localMusicTrackByID)。
func decodeLocalSongID(id string) (string, bool) {
	if !strings.HasPrefix(id, localSongIDPrefix) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(id, localSongIDPrefix))
	if err != nil {
		return "", false
	}
	return string(raw), true
}

// liveCheckSong 对单首在线歌曲做验活 + 探测真实格式。
// 用 NewSourceRangeFetch(与 stream 同一下载路径),它按文件魔数判真实格式 +
// 返回真实总大小 —— 关键:GetDownloadFunc 直连可能拿到 128k mp3,而 stream
// 走 RangeFetch 拿到 VIP FLAC,两者不一致会导致声明 mp3 实流 FLAC 播不出。
func liveCheckSong(song model.Song) (ok bool, size int64, ext string) {
	fn := core.GetDownloadFunc(song.Source)
	if fn == nil {
		return false, 0, ""
	}
	urlStr, err := fn(&song)
	if err != nil || urlStr == "" {
		return false, 0, ""
	}
	// 优先用 RangeFetch(与 stream 同路径):按魔数判真实格式 + 真实大小。
	if rf, handled, rfErr := core.NewSourceRangeFetch(urlStr, song.Source, "bytes=0-1"); rfErr == nil && handled && rf != nil {
		realExt := strings.ToLower(strings.TrimPrefix(rf.Ext, "."))
		total := rf.Total
		if total <= 0 {
			total = rf.ContentLength
		}
		return true, total, realExt
	}
	// 退化:普通 Range 探测(拿不到真实格式时靠 URL/Content-Type 猜)。
	req, reqErr := core.BuildSourceRequest("GET", urlStr, song.Source, "bytes=0-1")
	if reqErr != nil {
		return false, 0, ""
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false, 0, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return false, 0, ""
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if parts := strings.Split(cr, "/"); len(parts) == 2 {
			size, _ = strconv.ParseInt(parts[1], 10, 64)
		}
	}
	if size == 0 {
		size = resp.ContentLength
	}
	// 判真实格式:优先 URL 路径后缀,其次 Content-Type。
	ext = detectRealExt(urlStr, resp.Header.Get("Content-Type"))
	return true, size, ext
}

// detectRealExt 从下载 URL 后缀或 Content-Type 判断真实音频格式后缀。
func detectRealExt(urlStr, contentType string) string {
	lower := strings.ToLower(urlStr)
	// 去掉 query 再看后缀
	if i := strings.IndexByte(lower, '?'); i >= 0 {
		lower = lower[:i]
	}
	for _, e := range []string{".flac", ".mp3", ".m4a", ".ogg", ".wav", ".aac"} {
		if strings.HasSuffix(lower, e) {
			return strings.TrimPrefix(e, ".")
		}
	}
	switch {
	case strings.Contains(contentType, "flac"):
		return "flac"
	case strings.Contains(contentType, "mp4"), strings.Contains(contentType, "m4a"):
		return "m4a"
	case strings.Contains(contentType, "ogg"):
		return "ogg"
	case strings.Contains(contentType, "mpeg"):
		return "mp3"
	}
	return ""
}

// liveCheckSongs 并发验活一批歌曲,过滤死链/版权受限,只返回能播的。
// 限并发(默认 6,与前端 useLiveCheck 一致)避免压垮上游。
// 给每首存活歌曲回填真实 Size/Bitrate(用于 Subsonic song 元素展示)。
func liveCheckSongs(songs []model.Song, concurrency int) []model.Song {
	if concurrency <= 0 {
		concurrency = 6
	}
	type result struct {
		idx  int
		song model.Song
		ok   bool
	}
	sem := make(chan struct{}, concurrency)
	resCh := make(chan result, len(songs))
	var wg sync.WaitGroup
	for i, s := range songs {
		wg.Add(1)
		go func(idx int, song model.Song) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ok, size, ext := liveCheckSong(song)
			if ok {
				if size > 0 {
					song.Size = size
					if song.Duration > 0 {
						song.Bitrate = int((size * 8) / int64(song.Duration) / 1000)
					}
				}
				// 回填真实格式:声明格式必须与实际流一致,否则客户端按错误解码器播不出。
				if ext != "" {
					song.Ext = ext
				}
			}
			resCh <- result{idx: idx, song: song, ok: ok}
		}(i, s)
	}
	wg.Wait()
	close(resCh)

	// 按原始顺序收集存活结果(保持搜索相关性排序)。
	alive := make([]model.Song, len(songs))
	keep := make([]bool, len(songs))
	for r := range resCh {
		alive[r.idx] = r.song
		keep[r.idx] = r.ok
	}
	out := make([]model.Song, 0, len(songs))
	for i := range alive {
		if keep[i] {
			out = append(out, alive[i])
		}
	}
	return out
}

// songToSubsonicChild 把一首在线歌曲映射成 Subsonic song 元素。
// 带上 albumId/artistId(合成 id)并把封面记入映射表 —— 音流播放页可能
// 用 albumId/artistId 取封面而非 song 自身的 coverArt,缺这俩会拿空 id 查不到图。
// estimateDuration 在源未提供时长时估算秒数:有 size+bitrate 用公式,
// 否则按格式典型码率(FLAC~1000k,mp3~320k)反推。返回 0 表示估不出。
func estimateDuration(size int64, bitrate int, suffix string) int {
	if size <= 0 {
		return 0
	}
	kbps := bitrate
	if kbps <= 0 {
		switch suffix {
		case "flac", "wav":
			kbps = 1000
		case "m4a", "ogg":
			kbps = 256
		default: // mp3 等
			kbps = 320
		}
	}
	sec := (size * 8) / int64(kbps) / 1000
	if sec <= 0 {
		return 0
	}
	return int(sec)
}

func songToSubsonicChild(song model.Song) subsonicChild {
	id := encodeOnlineSongID(song)
	suffix := strings.ToLower(strings.TrimPrefix(song.Ext, "."))
	if suffix == "" {
		suffix = "mp3"
	}
	// duration 缺失时估算:音流等客户端没时长无法建立播放时间轴,会反复重拉
	// 死循环(完整拉几十遍、从不 seek)。有 size+bitrate 时按公式算,否则按
	// 格式典型码率估。宁可估个近似值也不能留空。
	duration := song.Duration
	if duration <= 0 {
		duration = estimateDuration(song.Size, song.Bitrate, suffix)
	}
	bitrate := song.Bitrate
	if bitrate <= 0 && song.Size > 0 && duration > 0 {
		bitrate = int((song.Size * 8) / int64(duration) / 1000)
	}
	child := subsonicChild{
		ID:          id,
		IsDir:       false,
		Title:       song.Name,
		Album:       song.Album,
		Artist:      song.Artist,
		Duration:    duration,
		BitRate:     bitrate,
		Size:        song.Size,
		Suffix:      suffix,
		ContentType: core.AudioMimeByExt(suffix),
		Type:        "music",
	}
	if song.Cover != "" {
		child.CoverArt = id // getCoverArt 用同一 id 解析封面
	}
	// 带上 albumId/artistId,并把封面记入映射表(播放页用这俩 id 取封面时能查到)。
	if song.Album != "" {
		child.AlbumID = "album:" + base64.RawURLEncoding.EncodeToString([]byte(song.Album))
		globalCoverStore.put(coverStoreKey("album", song.Album), song.Cover)
	}
	if song.Artist != "" {
		child.ArtistID = "artist:" + base64.RawURLEncoding.EncodeToString([]byte(song.Artist))
		globalCoverStore.put(coverStoreKey("artist", song.Artist), song.Cover)
	}
	return child
}

// subsonicSearch3 处理 search3:联网搜索 → 验活 → 映射成 searchResult3。
// query 为空时返回空结果(不报错,兼容客户端"清空搜索框"行为)。
func subsonicSearch3(c *gin.Context) {
	query := strings.TrimSpace(c.Query("query"))
	songCount := parseIntDefault(c.Query("songCount"), 20)

	resp := newSubsonicOK()
	result := &searchResult3Body{
		Artists: []subsonicArtist{},
		Albums:  []subsonicAlbum{},
		Songs:   []subsonicChild{},
	}
	resp.SearchResult3 = result

	if query == "" {
		respondSubsonic(c, resp)
		return
	}

	// 多源并发搜索(复用现有逻辑),默认 song 类型。
	songs, _ := concurrentKeywordSearch(query, "song", defaultSourcesForSearchType("song"))

	// 验活前先裁候选:多源合并常 60~100 首,全量验活约 20~25s,
	// 而 Subsonic 客户端(音流)通常 30s 超时,验完再截断既浪费又可能超时。
	// 取 songCount 的若干倍(留验活淘汰余量),封顶 candidateCap 控制总延迟。
	candidates := candidateLimit(songCount)
	if len(songs) > candidates {
		songs = songs[:candidates]
	}

	// 验活:过滤死链/版权受限,只把能播的返回客户端。
	songs = liveCheckSongs(songs, 6)

	// 排序(与前端 Download.js 一致):相关性降序,同分按真实码率降序。
	// Subsonic 客户端按服务端返回顺序展示,故排序必须在后端做。
	sortSongsByRelevance(songs, query)

	if songCount > 0 && len(songs) > songCount {
		songs = songs[:songCount]
	}

	// 聚合 artist/album(去重)。封面:用该 artist/album 下首次出现歌曲的
	// 编码 id 作 coverArt(getCoverArt 解析出在线封面 URL),否则客户端无图。
	seenArtist := make(map[string]bool)
	seenAlbum := make(map[string]bool)
	for _, s := range songs {
		child := songToSubsonicChild(s)
		result.Songs = append(result.Songs, child)
		if s.Artist != "" && !seenArtist[s.Artist] {
			seenArtist[s.Artist] = true
			globalCoverStore.put(coverStoreKey("artist", s.Artist), s.Cover)
			result.Artists = append(result.Artists, subsonicArtist{
				ID:       "artist:" + base64.RawURLEncoding.EncodeToString([]byte(s.Artist)),
				Name:     s.Artist,
				CoverArt: child.CoverArt,
			})
		}
		if s.Album != "" && !seenAlbum[s.Album] {
			seenAlbum[s.Album] = true
			globalCoverStore.put(coverStoreKey("album", s.Album), s.Cover)
			result.Albums = append(result.Albums, subsonicAlbum{
				ID:       "album:" + base64.RawURLEncoding.EncodeToString([]byte(s.Album)),
				Name:     s.Album,
				Artist:   s.Artist,
				CoverArt: child.CoverArt,
			})
		}
	}

	respondSubsonic(c, resp)
}

// relevanceScore 与前端 Download.js 的 relevanceScore 一致:
// 歌名完全相等=1000/开头=600/包含=400/否则多词命中(歌名+2 歌手+1)*50;
// 歌手也含 query 再 +80。分越高越相关。
func relevanceScore(song model.Song, query string) int {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return 0
	}
	name := strings.ToLower(song.Name)
	artist := strings.ToLower(song.Artist)
	var score int
	switch {
	case name == q:
		score = 1000
	case strings.HasPrefix(name, q):
		score = 600
	case strings.Contains(name, q):
		score = 400
	default:
		hit := 0
		for _, p := range strings.Fields(q) {
			if strings.Contains(name, p) {
				hit += 2
			} else if strings.Contains(artist, p) {
				hit++
			}
		}
		score = hit * 50
	}
	if strings.Contains(artist, q) {
		score += 80
	}
	return score
}

// sortSongsByRelevance 原地排序:相关性降序,同分按真实码率(验活回填的 Bitrate)降序,
// 再同则保持稳定。与前端默认排序一致。
func sortSongsByRelevance(songs []model.Song, query string) {
	sort.SliceStable(songs, func(i, j int) bool {
		si, sj := relevanceScore(songs[i], query), relevanceScore(songs[j], query)
		if si != sj {
			return si > sj
		}
		return songs[i].Bitrate > songs[j].Bitrate
	})
}

// parseIntDefault 解析整数,失败返回默认值。
func parseIntDefault(s string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return v
	}
	return def
}

// candidateLimit 计算验活前的候选上限:songCount 的 candidateFactor 倍
// (留出验活淘汰的余量,死链多时仍能凑够 songCount),封顶 candidateCap
// 控制总延迟(验活并发6,候选越多越接近客户端超时)。
const (
	candidateFactor = 3
	candidateCap    = 40
)

func candidateLimit(songCount int) int {
	if songCount <= 0 {
		songCount = 20
	}
	limit := songCount * candidateFactor
	if limit > candidateCap {
		limit = candidateCap
	}
	return limit
}
