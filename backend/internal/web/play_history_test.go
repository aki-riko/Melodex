package web

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/guohuiyuan/music-lib/model"
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
		Songs: []model.Song{{
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
