package web

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aki-riko/Melodex/backend/internal/provider/bridge"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

// 验证播放历史:去重(同歌重播刷新时间不新增行)+ 按 played_at 降序 + 用户隔离 + 超限剪枝。
func TestPlayHistoryDedupAndOrder(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1234", RoleUser)

	// alice 播放 A、B
	recordPlayHistory(alice.ID, "A", "qq", "songA", "art", "", 100, "")
	recordPlayHistory(alice.ID, "B", "netease", "songB", "art", "", 120, "")
	// 重播 A:应去重(仍 2 条)并把 A 顶到最前(played_at 更新)。
	time.Sleep(10 * time.Millisecond)
	recordPlayHistory(alice.ID, "A", "qq", "songA", "art", "", 100, "")

	rows, err := listPlayHistory(alice.ID, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("dedup: want 2 rows, got %d", len(rows))
	}
	if rows[0].SongID != "A" {
		t.Fatalf("most recent should be A(replayed), got %s", rows[0].SongID)
	}

	// 用户隔离:bob 看不到 alice 的历史。
	bobRows, _ := listPlayHistory(bob.ID, 0)
	if len(bobRows) != 0 {
		t.Fatalf("bob should see 0 rows, got %d", len(bobRows))
	}

	// userID=0 一律空。
	anon, _ := listPlayHistory(0, 0)
	if len(anon) != 0 {
		t.Fatalf("userID=0 should return empty, got %d", len(anon))
	}
}

// 验证超过 playHistoryMax 时剪掉最旧的(剪枝)。
func TestPlayHistoryPrune(t *testing.T) {
	setupUserTestDB(t)
	u, _ := createUser("carol", "carolpass1", RoleUser)

	// 插 playHistoryMax+5 条,每条不同 song_id,递增 played_at。
	base := time.Now().Add(-time.Hour)
	for i := 0; i < playHistoryMax+5; i++ {
		row := playHistoryRow{
			UserID:   u.ID,
			SongID:   "s" + time.Duration(i).String(),
			Source:   "qq",
			Name:     "n",
			PlayedAt: base.Add(time.Duration(i) * time.Second),
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	prunePlayHistory(u.ID)

	var count int64
	db.Model(&playHistoryRow{}).Where("user_id = ?", u.ID).Count(&count)
	if count != playHistoryMax {
		t.Fatalf("after prune want %d rows, got %d", playHistoryMax, count)
	}
	// 最旧的(s0)应被剪掉。
	var oldest int64
	db.Model(&playHistoryRow{}).Where("user_id = ? AND song_id = ?", u.ID, "s0s").Count(&oldest)
	// s0 的 song_id 是 "s" + Duration(0).String() = "s0s"
	if oldest != 0 {
		t.Fatalf("oldest row should be pruned, still present")
	}
}

func TestPlayHistoryBackfillAlbumFromSearchCache(t *testing.T) {
	setupUserTestDB(t)
	u, _ := createUser("dave", "davepass1", RoleUser)

	payload, err := json.Marshal(jsonSearchResponse{
		Songs: []model.Track{{
			ID:      "song-1",
			Source:  "qq",
			Name:    "Song One",
			Artist:  "Artist A",
			Album:   "Cached Album",
			AlbumID: "cached-album-1",
		}},
		Type: "song",
	})
	if err != nil {
		t.Fatalf("marshal cache payload: %v", err)
	}
	if err := db.Create(&searchCacheRow{Key: "history-album-cache", Payload: string(payload), CreatedAt: time.Now()}).Error; err != nil {
		t.Fatalf("create search cache: %v", err)
	}

	recordPlayHistory(u.ID, "song-1", "qq", "Song One", "Artist A", "", 100, `{"songmid":"song-1"}`)
	rows, err := listPlayHistory(u.ID, 0)
	if err != nil {
		t.Fatalf("list play history: %v", err)
	}
	songs := playHistoryToSongs(rows)
	if len(songs) != 1 || songs[0]["album"] != "Cached Album" || songs[0]["album_id"] != "cached-album-1" {
		t.Fatalf("history songs = %#v, want cached album metadata", songs)
	}

	var saved playHistoryRow
	if err := db.Where("user_id = ? AND song_id = ?", u.ID, "song-1").First(&saved).Error; err != nil {
		t.Fatalf("reload play history: %v", err)
	}
	extra := decodeSongExtraMap(saved.Extra)
	if extraMapAlbum(extra) != "Cached Album" || extraMapAlbumID(extra) != "cached-album-1" {
		t.Fatalf("history extra after backfill = %#v, want cached album metadata", extra)
	}
}

func TestEncodeSongExtraWithMetadataAddsAlbumFields(t *testing.T) {
	raw := encodeSongExtraWithMetadata(map[string]interface{}{"link": "https://example.test/song"}, "测试专辑", "album-1")
	extra := decodeSongExtraMap(raw)
	if extraMapValue(extra, "link") != "https://example.test/song" {
		t.Fatalf("link should be preserved, got %#v", extra)
	}
	if extraMapValue(extra, "album") != "测试专辑" || extraMapValue(extra, "album_id") != "album-1" {
		t.Fatalf("album metadata missing, got %#v", extra)
	}

	raw = encodeSongExtraWithMetadata(map[string]interface{}{"album": "已有专辑"}, "新专辑", "")
	extra = decodeSongExtraMap(raw)
	if extraMapValue(extra, "album") != "已有专辑" {
		t.Fatalf("existing album should win, got %#v", extra)
	}

	raw = encodeSongExtraWithMetadata(map[string]interface{}{"albumName": "别名专辑", "albumMid": "mid-1"}, "", "")
	extra = decodeSongExtraMap(raw)
	if extraMapValue(extra, "album") != "别名专辑" || extraMapValue(extra, "album_id") != "mid-1" {
		t.Fatalf("album aliases should be normalized, got %#v", extra)
	}
}

// TestPlayHistoryBackfillsChorusIntoExtra 锁住「最近播放」的副歌回填(2026-11 生产反馈)。
//
// 现场: 用户从「最近播放」点开一首网易歌, 进度条上没有副歌标记。原因是 play_history_rows
// 存的是**播放当时**的 extra 快照 —— 那时还没有 chorus_* 字段, 而前端只认 extra 里的值。
// 只在「已下载」列表做回填是不够的: 展示层读到旧快照, 就永远看不到标记。
//
// 这里断言的是"读取时补", 而不是"写入时补": 历史行本身不该被改写(它是播放记录,
// 不是元数据表), 但返回给前端的结构必须带上副歌。
func TestPlayHistoryBackfillsChorusIntoExtra(t *testing.T) {
	setupUserTestDB(t)
	resetLocalChorusCacheForTest()
	t.Cleanup(resetLocalChorusCacheForTest)

	u, _ := createUser("chorushist", "choruspass1", RoleUser)

	// 历史行里**没有**副歌字段 —— 模拟"播放发生在功能上线之前"。
	recordPlayHistory(u.ID, "1398663411", "netease", "冬眠", "司南", "", 269, `{"album":"冬眠"}`)
	rows, err := listPlayHistory(u.ID, 0)
	if err != nil {
		t.Fatalf("list play history: %v", err)
	}

	// 上游给出真实点位(真机实测过: 冬眠 92894~122397)。
	withChorusStub(t, func(_ context.Context, request bridge.ChorusRequest) (map[string]model.ChorusPoint, error) {
		return map[string]model.ChorusPoint{"1398663411": {Start: 92894, End: 122397}}, nil
	})

	songs := playHistoryToSongs(rows)
	if len(songs) != 1 {
		t.Fatalf("songs = %d, want 1", len(songs))
	}
	extra, ok := songs[0]["extra"].(map[string]string)
	if !ok {
		t.Fatalf("extra = %#v, want map with chorus keys", songs[0]["extra"])
	}
	if extra["chorus_start_ms"] != "92894" || extra["chorus_end_ms"] != "122397" {
		t.Fatalf("chorus = %q/%q, want 92894/122397 (最近播放必须补副歌)",
			extra["chorus_start_ms"], extra["chorus_end_ms"])
	}
	// 原有字段不能被冲掉(前端还要用它渲染专辑)。
	if extra["album"] != "冬眠" {
		t.Fatalf("album lost: %#v", extra)
	}

	// 历史行本身不该被改写 —— 它是播放记录, 不是元数据表。
	var saved playHistoryRow
	if err := db.Where("user_id = ? AND song_id = ?", u.ID, "1398663411").First(&saved).Error; err != nil {
		t.Fatalf("reload history: %v", err)
	}
	if strings.Contains(saved.Extra, "chorus_start_ms") {
		t.Fatalf("history row must not be rewritten with chorus, got %q", saved.Extra)
	}
}
