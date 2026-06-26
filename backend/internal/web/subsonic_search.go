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

// liveCheckSong 对单首在线歌曲做验活:取真实下载 URL 后发 Range 探测,
// 返回是否可播 + 真实字节大小(用于推算码率)。复用 /music/inspect 的判定逻辑。
func liveCheckSong(song model.Song) (ok bool, size int64) {
	fn := core.GetDownloadFunc(song.Source)
	if fn == nil {
		return false, 0
	}
	urlStr, err := fn(&song)
	if err != nil || urlStr == "" {
		return false, 0
	}
	req, reqErr := core.BuildSourceRequest("GET", urlStr, song.Source, "bytes=0-1")
	if reqErr != nil {
		return false, 0
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return false, 0
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if parts := strings.Split(cr, "/"); len(parts) == 2 {
			size, _ = strconv.ParseInt(parts[1], 10, 64)
		}
	}
	if size == 0 {
		size = resp.ContentLength
	}
	return true, size
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
			ok, size := liveCheckSong(song)
			if ok && size > 0 {
				song.Size = size
				if song.Duration > 0 {
					song.Bitrate = int((size * 8) / int64(song.Duration) / 1000)
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
func songToSubsonicChild(song model.Song) subsonicChild {
	id := encodeOnlineSongID(song)
	suffix := strings.ToLower(strings.TrimPrefix(song.Ext, "."))
	if suffix == "" {
		suffix = "mp3"
	}
	child := subsonicChild{
		ID:          id,
		IsDir:       false,
		Title:       song.Name,
		Album:       song.Album,
		Artist:      song.Artist,
		Duration:    song.Duration,
		BitRate:     song.Bitrate,
		Size:        song.Size,
		Suffix:      suffix,
		ContentType: core.AudioMimeByExt(suffix),
		Type:        "music",
	}
	if song.Cover != "" {
		child.CoverArt = id // getCoverArt 用同一 id 解析封面
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

	if songCount > 0 && len(songs) > songCount {
		songs = songs[:songCount]
	}

	// 聚合 artist/album(去重),歌曲逐条映射。
	seenArtist := make(map[string]bool)
	seenAlbum := make(map[string]bool)
	for _, s := range songs {
		result.Songs = append(result.Songs, songToSubsonicChild(s))
		if s.Artist != "" && !seenArtist[s.Artist] {
			seenArtist[s.Artist] = true
			result.Artists = append(result.Artists, subsonicArtist{
				ID:   "artist:" + base64.RawURLEncoding.EncodeToString([]byte(s.Artist)),
				Name: s.Artist,
			})
		}
		if s.Album != "" && !seenAlbum[s.Album] {
			seenAlbum[s.Album] = true
			result.Albums = append(result.Albums, subsonicAlbum{
				ID:     "album:" + base64.RawURLEncoding.EncodeToString([]byte(s.Album)),
				Name:   s.Album,
				Artist: s.Artist,
			})
		}
	}

	respondSubsonic(c, resp)
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
