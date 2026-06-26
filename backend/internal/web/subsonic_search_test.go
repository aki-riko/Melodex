package web

import (
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
