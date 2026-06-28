package web

import (
	"testing"
	"time"
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
