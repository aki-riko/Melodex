package web

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestOnlineSongIDRoundtrip(t *testing.T) {
	song := model.Song{
		Source: "netease",
		ID:     "12345",
		Name:   "晴天",
		Artist: "周杰伦",
		Album:  "叶惠美",
		Cover:  "http://example.com/cover.jpg",
		Extra:  map[string]string{"hash": "abc", "br": "999"},
	}
	id := encodeOnlineSongID(song)
	if !strings.HasPrefix(id, onlineSongIDPrefix) {
		t.Fatalf("id 应带在线前缀: %s", id)
	}

	decoded, ok := decodeOnlineSongID(id)
	if !ok {
		t.Fatal("解码应成功")
	}
	if decoded.Source != song.Source || decoded.ID != song.ID || decoded.Name != song.Name ||
		decoded.Artist != song.Artist || decoded.Album != song.Album || decoded.Cover != song.Cover {
		t.Fatalf("核心字段还原错误: %+v", decoded)
	}
	// extra 从映射表取回
	if decoded.Extra["hash"] != "abc" || decoded.Extra["br"] != "999" {
		t.Fatalf("extra 还原错误: %+v", decoded.Extra)
	}
}

func TestOnlineSongIDHandlesSpecialChars(t *testing.T) {
	// 含分隔符、斜杠、中文、空格的字段不能破坏编解码。
	song := model.Song{
		Source: "qq",
		ID:     "a/b+c=d",
		Name:   "Song | Name",
		Artist: "Artist/With\x1fWeird",
		Album:  "专辑 名",
	}
	id := encodeOnlineSongID(song)
	decoded, ok := decodeOnlineSongID(id)
	if !ok {
		t.Fatal("特殊字符 id 解码应成功")
	}
	if decoded.ID != song.ID || decoded.Name != song.Name || decoded.Album != song.Album {
		t.Fatalf("特殊字符还原错误: %+v", decoded)
	}
}

func TestDecodeOnlineSongIDRejectsBadInput(t *testing.T) {
	if _, ok := decodeOnlineSongID("loc:abc"); ok {
		t.Fatal("本地前缀 id 不应被在线解码器接受")
	}
	if _, ok := decodeOnlineSongID("ts1:!!!notbase64!!!"); ok {
		t.Fatal("非法 base64 不应解码成功")
	}
	if _, ok := decodeOnlineSongID("plainstring"); ok {
		t.Fatal("无前缀字符串不应解码成功")
	}
}

func TestLocalSongIDRoundtrip(t *testing.T) {
	id := encodeLocalSongID("some/rel/path - 周杰伦.flac")
	if !strings.HasPrefix(id, localSongIDPrefix) {
		t.Fatalf("应带本地前缀: %s", id)
	}
	got, ok := decodeLocalSongID(id)
	if !ok || got != "some/rel/path - 周杰伦.flac" {
		t.Fatalf("本地 id 还原错误: %q ok=%v", got, ok)
	}
	// 在线 id 不应被本地解码器接受
	if _, ok := decodeLocalSongID("ts1:abc"); ok {
		t.Fatal("在线前缀不应被本地解码器接受")
	}
}

func TestExtraStoreEviction(t *testing.T) {
	store := &songExtraStore{data: make(map[string]map[string]string), maxSize: 3}
	for i := 0; i < 5; i++ {
		store.put(extraKey("src", string(rune('a'+i))), map[string]string{"k": "v"})
	}
	// 超上限会清空重建,长度不应超过 maxSize
	if len(store.data) > store.maxSize {
		t.Fatalf("映射表超过上限未清理: %d", len(store.data))
	}
}

func TestSubsonicSearch3EmptyQuery(t *testing.T) {
	r := newSubsonicTestRouter(t)
	salt := "abcdef"
	token := makeToken("sesame", salt)
	// 空 query 应返回 ok + 空 searchResult3,不报错
	url := "/rest/search3?u=kotori&t=" + token + "&s=" + salt + "&v=1.16.1&c=test&f=json&query="
	req := httptest.NewRequest(http.MethodGet, url, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, "\"status\":\"ok\"") {
		t.Fatalf("空 query 应返回 ok: %s", body)
	}
	if !strings.Contains(body, "searchResult3") {
		t.Fatalf("应含 searchResult3: %s", body)
	}
}

func TestEstimateDuration(t *testing.T) {
	// 有 bitrate:35661811 字节 * 8 / 1111 / 1000 ≈ 256s
	if got := estimateDuration(35661811, 1111, "flac"); got < 250 || got > 262 {
		t.Fatalf("有码率估算应约256s, 实际 %d", got)
	}
	// 无 bitrate 的 FLAC:按 1000k 估
	if got := estimateDuration(35661811, 0, "flac"); got < 270 || got > 290 {
		t.Fatalf("FLAC无码率按1000k估应约285s, 实际 %d", got)
	}
	// 无 bitrate 的 mp3:按 320k
	if got := estimateDuration(4087052, 0, "mp3"); got < 95 || got > 108 {
		t.Fatalf("mp3无码率按320k估应约102s, 实际 %d", got)
	}
	// 无 size:估不出返 0
	if got := estimateDuration(0, 0, "flac"); got != 0 {
		t.Fatalf("无size应返0, 实际 %d", got)
	}
}

func TestSongToSubsonicChildFillsDuration(t *testing.T) {
	// 源没给 duration(=0)但有 size:必须估算出非零 duration,
	// 否则音流没时长会反复重拉死循环。
	song := model.Song{
		Source: "qq", ID: "x", Name: "t", Artist: "a",
		Ext: "flac", Size: 35661811, Duration: 0, Bitrate: 0,
	}
	child := songToSubsonicChild(song)
	if child.Duration <= 0 {
		t.Fatalf("duration 缺失时必须估算非零, 实际 %d", child.Duration)
	}
}

func TestDetectRealExt(t *testing.T) {
	cases := []struct {
		url, ct, want string
	}{
		{"http://x/song.flac", "", "flac"},
		{"http://x/song.flac?vkey=abc&t=1", "", "flac"},      // 带 query
		{"http://x/song.mp3", "", "mp3"},
		{"http://x/a/b.m4a?x=1", "audio/mp4", "m4a"},
		{"http://x/nopath", "audio/flac", "flac"},            // 无后缀靠 Content-Type
		{"http://x/nopath", "audio/mpeg", "mp3"},
		{"http://x/stream?id=1", "application/octet-stream", ""}, // 都判不出
	}
	for _, c := range cases {
		if got := detectRealExt(c.url, c.ct); got != c.want {
			t.Fatalf("detectRealExt(%q,%q)=%q want %q", c.url, c.ct, got, c.want)
		}
	}
}

func TestResolveSyntheticCoverURL(t *testing.T) {
	// 用唯一名称避免与其他测试经 songToSubsonicChild 写入的全局映射冲突
	// (coverURLStore 保留首次写入)。
	an := "测试歌手_RSC_" + t.Name()
	bn := "测试专辑_RSC_" + t.Name()
	globalCoverStore.put(coverStoreKey("artist", an), "http://cdn/jay.jpg")
	globalCoverStore.put(coverStoreKey("album", bn), "http://cdn/yhm.jpg")

	artistID := "artist:" + base64.RawURLEncoding.EncodeToString([]byte(an))
	albumID := "album:" + base64.RawURLEncoding.EncodeToString([]byte(bn))

	// 裸合成 id
	if got := resolveSyntheticCoverURL(artistID); got != "http://cdn/jay.jpg" {
		t.Fatalf("artist 封面解析错误: %q", got)
	}
	// 音流加 ar-/al- 前缀也要能解
	if got := resolveSyntheticCoverURL("ar-" + artistID); got != "http://cdn/jay.jpg" {
		t.Fatalf("带 ar- 前缀解析错误: %q", got)
	}
	if got := resolveSyntheticCoverURL("al-" + albumID); got != "http://cdn/yhm.jpg" {
		t.Fatalf("带 al- 前缀解析错误: %q", got)
	}
	// 未知名称返回空
	unknown := "artist:" + base64.RawURLEncoding.EncodeToString([]byte("查无此人"))
	if got := resolveSyntheticCoverURL(unknown); got != "" {
		t.Fatalf("未知应返回空: %q", got)
	}
	// 非合成 id 返回空
	if got := resolveSyntheticCoverURL("ts1:abc"); got != "" {
		t.Fatalf("非合成 id 应返回空: %q", got)
	}
}

func TestStripClientIDPrefix(t *testing.T) {
	// 仅当剥离后是已知 id 前缀才剥
	if got := stripClientIDPrefix("ar-ts1:abc"); got != "ts1:abc" {
		t.Fatalf("应剥离 ar- 还原 ts1: , 实际 %q", got)
	}
	if got := stripClientIDPrefix("al-loc:xyz"); got != "loc:xyz" {
		t.Fatalf("应剥离 al- 还原 loc: , 实际 %q", got)
	}
	// 剥离后不是已知前缀,不动(避免误伤 artist:/album:)
	if got := stripClientIDPrefix("ar-artist:abc"); got != "ar-artist:abc" {
		t.Fatalf("artist 合成 id 不应被剥, 实际 %q", got)
	}
	// 无前缀不动
	if got := stripClientIDPrefix("ts1:abc"); got != "ts1:abc" {
		t.Fatalf("无前缀不应改, 实际 %q", got)
	}
}

func TestUpstreamRankScore(t *testing.T) {
	mk := func(rank string) model.Song {
		return model.Song{Extra: map[string]string{"_rank": rank}}
	}
	if upstreamRankScore(mk("0")) != 500 {
		t.Fatal("上游第1名应=500")
	}
	if upstreamRankScore(mk("1")) != 470 {
		t.Fatal("第2名应=470")
	}
	if upstreamRankScore(mk("100")) != 0 {
		t.Fatal("极靠后应封底0")
	}
	if upstreamRankScore(model.Song{}) != 0 {
		t.Fatal("无rank应=0")
	}
}

func TestCombinedScoreTranslationName(t *testing.T) {
	// 译名场景:query="珍珠星的距离",原名"スピカテリブル"本地匹配=0,
	// 但上游把它排第1(rank=0)→ 综合分应=500,能顶上来。
	q := "珍珠星的距离"
	orig := model.Song{Name: "スピカテリブル", Artist: "内田彩", Extra: map[string]string{"_rank": "0"}}
	other := model.Song{Name: "别的歌", Artist: "X", Extra: map[string]string{"_rank": "5"}}

	so := combinedScore(orig, q)
	oo := combinedScore(other, q)
	if so <= 0 {
		t.Fatalf("译名场景原名应靠上游名次得分>0, 实际 %d", so)
	}
	if so <= oo {
		t.Fatalf("上游排第1的原名(%d)应高于排第5的(%d)", so, oo)
	}
}

func TestCombinedScoreDirectHitNotBroken(t *testing.T) {
	// 直接命中场景:搜"晴天",本地完全匹配=1000 主导,
	// 不能被一首上游排第1但歌名不匹配的歌盖过。
	q := "晴天"
	hit := model.Song{Name: "晴天", Artist: "周杰伦", Extra: map[string]string{"_rank": "8"}}
	upstreamTop := model.Song{Name: "无关歌", Artist: "Y", Extra: map[string]string{"_rank": "0"}}

	if combinedScore(hit, q) <= combinedScore(upstreamTop, q) {
		t.Fatalf("直接命中歌名(本地1000)应高于仅上游第1的无关歌: hit=%d top=%d",
			combinedScore(hit, q), combinedScore(upstreamTop, q))
	}
}

func TestSortSongsByRelevanceWithUpstream(t *testing.T) {
	q := "珍珠星的距离"
	songs := []model.Song{
		{Name: "无关A", Artist: "A", Extra: map[string]string{"_rank": "3"}, Bitrate: 999},
		{Name: "スピカテリブル", Artist: "内田彩", Extra: map[string]string{"_rank": "0"}, Bitrate: 128},
		{Name: "无关B", Artist: "B", Extra: map[string]string{"_rank": "1"}, Bitrate: 320},
	}
	sortSongsByRelevance(songs, q)
	if songs[0].Name != "スピカテリブル" {
		t.Fatalf("译名搜索应把上游第1的原名置顶, 实际首位 %s", songs[0].Name)
	}
}

func TestRelevanceScore(t *testing.T) {
	q := "晴天"
	exact := model.Song{Name: "晴天", Artist: "周杰伦"}
	prefix := model.Song{Name: "晴天娃娃", Artist: "X"}
	contain := model.Song{Name: "好想见你的晴天", Artist: "Y"}
	noise := model.Song{Name: "完全无关", Artist: "Z"}

	if relevanceScore(exact, q) <= relevanceScore(prefix, q) {
		t.Fatal("完全相等应高于前缀匹配")
	}
	if relevanceScore(prefix, q) <= relevanceScore(contain, q) {
		t.Fatal("前缀应高于包含")
	}
	if relevanceScore(noise, q) != 0 {
		t.Fatalf("噪声应为 0, 实际 %d", relevanceScore(noise, q))
	}
	// 多词:歌名命中+歌手命中
	multi := relevanceScore(model.Song{Name: "晴天", Artist: "周杰伦"}, "周杰伦 晴天")
	if multi <= 0 {
		t.Fatalf("多词命中应 >0, 实际 %d", multi)
	}
}

func TestSortSongsByRelevance(t *testing.T) {
	q := "晴天"
	songs := []model.Song{
		{Name: "无关歌", Artist: "A", Bitrate: 999},   // 噪声,应沉底
		{Name: "晴天", Artist: "周杰伦", Bitrate: 900}, // 完全相等原唱 → 应最前
		{Name: "晴天娃娃", Artist: "B", Bitrate: 320},  // 前缀匹配
	}
	sortSongsByRelevance(songs, q)

	// 首位:高码率完全匹配的原唱
	if songs[0].Name != "晴天" || songs[0].Bitrate != 900 {
		t.Fatalf("首位应是完全匹配原唱, 实际 %+v", songs[0])
	}
	// 末位:噪声沉底
	if songs[len(songs)-1].Name != "无关歌" {
		t.Fatalf("噪声应沉底, 实际末位 %+v", songs[len(songs)-1])
	}
}

func TestCoverPenaltyDemotesCover(t *testing.T) {
	q := "晴天"
	songs := []model.Song{
		{Name: "晴天", Artist: "翻唱歌手", Bitrate: 999},     // 标记翻唱,应被压
		{Name: "晴天", Artist: "周杰伦", Bitrate: 128},      // 原唱低码率
		{Name: "晴天 (钢琴版)", Artist: "X", Bitrate: 900}, // 钢琴版,重罚
	}
	sortSongsByRelevance(songs, q)
	// 原唱(周杰伦)应排在翻唱和钢琴版之前,即便码率低
	if songs[0].Artist != "周杰伦" {
		t.Fatalf("原唱应置顶于翻唱/演奏版前, 实际首位 %+v", songs[0])
	}
}

func TestCandidateLimit(t *testing.T) {
	cases := map[int]int{
		0:   20 * candidateFactor, // 0 → 默认 20 → 60 → 封顶 40
		20:  candidateCap,         // 60 → 封顶 40
		5:   15,                   // 5*3=15 < 40
		100: candidateCap,         // 远超封顶
		-1:  20 * candidateFactor, // 负数当默认
	}
	for in, want := range cases {
		// 0/20/100/-1 都会触发封顶或默认,统一按公式校验
		got := candidateLimit(in)
		expect := want
		if expect > candidateCap {
			expect = candidateCap
		}
		if got != expect {
			t.Fatalf("candidateLimit(%d)=%d, want %d", in, got, expect)
		}
		if got > candidateCap {
			t.Fatalf("candidateLimit(%d)=%d 超过封顶 %d", in, got, candidateCap)
		}
	}
}

func TestSongToSubsonicChild(t *testing.T) {
	song := model.Song{
		Source: "netease", ID: "1", Name: "晴天", Artist: "周杰伦",
		Album: "叶惠美", Duration: 269, Bitrate: 320, Size: 10000000,
		Ext: "flac", Cover: "http://x/c.jpg",
	}
	child := songToSubsonicChild(song)
	if child.Title != "晴天" || child.Artist != "周杰伦" || child.Suffix != "flac" {
		t.Fatalf("映射字段错误: %+v", child)
	}
	if child.CoverArt == "" {
		t.Fatal("有封面时 CoverArt 应非空")
	}
	// id 应可解码回原歌曲
	decoded, ok := decodeOnlineSongID(child.ID)
	if !ok || decoded.Name != "晴天" {
		t.Fatalf("child.ID 应可解码: %+v ok=%v", decoded, ok)
	}
}
