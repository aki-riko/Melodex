package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseM3UPrefersFilename(t *testing.T) {
	// 真实场景:EXTINF 只有歌名,文件名才含歌手 → 应优先用文件名做搜索词
	content := `#EXTM3U
#EXTINF:219.0,爱的供养
/app/media/爱的供养 - 杨幂.flac
#EXTINF:240.89,可不可以
/app/media/张紫豪 - 可不可以.flac
`
	entries, _ := parseM3U(content)
	if len(entries) != 2 {
		t.Fatalf("应 2 条, 实际 %d", len(entries))
	}
	if entries[0].Title != "爱的供养 - 杨幂" {
		t.Fatalf("应优先用文件名(含歌手), 实际 %q", entries[0].Title)
	}
	if entries[1].Title != "张紫豪 - 可不可以" {
		t.Fatalf("第2条应用文件名, 实际 %q", entries[1].Title)
	}
}

func TestM3UImportRejectsOversizedBodyBeforeJSONParse(t *testing.T) {
	initCollectionDBForTest(t)

	oldLimit := maxM3UImportBodyBytes
	maxM3UImportBodyBytes = 64
	t.Cleanup(func() {
		maxM3UImportBodyBytes = oldLimit
	})

	router := newCollectionTestRouter()
	body := `{"name":"huge","content":"` + strings.Repeat("x", 256) + `"}`
	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/collections/import_m3u", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized m3u import status = %d, want 413, body=%s", rec.Code, rec.Body.String())
	}
}

func TestParseM3UStandard(t *testing.T) {
	content := `#EXTM3U
#EXTINF:213,周杰伦 - 晴天
http://example.com/qingtian.mp3
#EXTINF:269,Eason Chan - 浮夸
/local/path/fukua.flac
`
	entries, isHLS := parseM3U(content)
	if isHLS {
		t.Fatal("标准音乐 m3u 不应判为 HLS")
	}
	if len(entries) != 2 {
		t.Fatalf("应解析 2 条, 实际 %d", len(entries))
	}
	if entries[0].Artist != "周杰伦" || entries[0].Name != "晴天" {
		t.Fatalf("第1条拆分错误: %+v", entries[0])
	}
	if entries[1].Artist != "Eason Chan" || entries[1].Name != "浮夸" {
		t.Fatalf("第2条拆分错误: %+v", entries[1])
	}
}

func TestParseM3URejectsHLS(t *testing.T) {
	content := `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.9,
segment0.ts
`
	_, isHLS := parseM3U(content)
	if !isHLS {
		t.Fatal("HLS 视频流应被识别")
	}
}

func TestParseM3UNoExtinfFallback(t *testing.T) {
	// 无 EXTINF,只有媒体行 → 用文件名兜底
	content := `http://example.com/music/Jay%20-%20Test.mp3
/songs/陈奕迅 - 十年.flac
`
	entries, _ := parseM3U(content)
	if len(entries) != 2 {
		t.Fatalf("应解析 2 条, 实际 %d: %+v", len(entries), entries)
	}
	// 第2条文件名含 " - " 应能拆出歌手
	if entries[1].Artist != "陈奕迅" || entries[1].Name != "十年" {
		t.Fatalf("文件名兜底拆分错误: %+v", entries[1])
	}
}

func TestSplitArtistTitle(t *testing.T) {
	cases := []struct{ in, artist, name string }{
		{"周杰伦 - 晴天", "周杰伦", "晴天"},
		{"晴天", "", "晴天"},
		{"A_B", "A", "B"},
	}
	for _, c := range cases {
		a, n := splitArtistTitle(c.in)
		if a != c.artist || n != c.name {
			t.Fatalf("splitArtistTitle(%q)=(%q,%q) want (%q,%q)", c.in, a, n, c.artist, c.name)
		}
	}
}
