package web

import (
	"testing"
)

// 验证 ensureFavoriteUniqueIndex 的去重迁移:历史/并发产生的多个「我喜欢」歌单
// 被正确合并到最小 id 那个(歌曲并入、重复丢弃),且之后唯一索引生效。
func TestEnsureFavoriteUniqueIndexDedup(t *testing.T) {
	setupUserTestDB(t)
	u, _ := createUser("alice", "alicepass1", RoleUser)

	// 先删唯一索引,才能插入重复 favorite 模拟历史脏数据。
	if err := db.Exec(`DROP INDEX IF EXISTS idx_fav_user`).Error; err != nil {
		t.Fatalf("drop index: %v", err)
	}
	// setupUserTestDB→createUser 已建了一个 favorite,取它作主歌单。
	fav1, err := ensureFavoriteCollection(u.ID)
	if err != nil {
		t.Fatalf("ensure fav1: %v", err)
	}
	// 主歌单放歌 A、B
	db.Create(&SavedSong{CollectionID: fav1.ID, SongID: "A", Source: "qq", Name: "a"})
	db.Create(&SavedSong{CollectionID: fav1.ID, SongID: "B", Source: "qq", Name: "b"})

	// 造第二个重复 favorite(id 更大),放歌 B(重复)、C(独有)
	fav2 := Collection{UserID: u.ID, Name: favoriteCollectionName, Kind: collectionKindFavorite, ContentType: collectionContentPlaylist, Source: "local"}
	if err := db.Create(&fav2).Error; err != nil {
		t.Fatalf("create dup fav: %v", err)
	}
	db.Create(&SavedSong{CollectionID: fav2.ID, SongID: "B", Source: "qq", Name: "b"})
	db.Create(&SavedSong{CollectionID: fav2.ID, SongID: "C", Source: "qq", Name: "c"})

	// 确认此刻确有 2 个 favorite
	var before int64
	db.Model(&Collection{}).Where("user_id = ? AND kind = ?", u.ID, collectionKindFavorite).Count(&before)
	if before != 2 {
		t.Fatalf("setup should have 2 favorites, got %d", before)
	}

	// 跑去重迁移
	if err := ensureFavoriteUniqueIndex(); err != nil {
		t.Fatalf("ensureFavoriteUniqueIndex: %v", err)
	}

	// 只剩 1 个 favorite,且是 fav1(最小 id)
	var after []Collection
	db.Where("user_id = ? AND kind = ?", u.ID, collectionKindFavorite).Find(&after)
	if len(after) != 1 {
		t.Fatalf("after dedup should have 1 favorite, got %d", len(after))
	}
	if after[0].ID != fav1.ID {
		t.Fatalf("survivor should be fav1(min id)=%d, got %d", fav1.ID, after[0].ID)
	}

	// 歌曲合并:A、B、C 各一条(B 去重),全挂在 fav1
	var songs []SavedSong
	db.Where("collection_id = ?", fav1.ID).Find(&songs)
	got := map[string]bool{}
	for _, s := range songs {
		got[s.SongID] = true
	}
	if len(songs) != 3 || !got["A"] || !got["B"] || !got["C"] {
		t.Fatalf("merged songs want A,B,C(3), got %d: %+v", len(songs), got)
	}

	// fav2 的歌曲已不存在(被并入或删除)
	var orphan int64
	db.Model(&SavedSong{}).Where("collection_id = ?", fav2.ID).Count(&orphan)
	if orphan != 0 {
		t.Fatalf("fav2 should have no leftover songs, got %d", orphan)
	}

	// 唯一索引已重建:再插重复 favorite 应失败
	dupErr := db.Create(&Collection{UserID: u.ID, Name: favoriteCollectionName, Kind: collectionKindFavorite, ContentType: collectionContentPlaylist, Source: "local"}).Error
	if dupErr == nil {
		t.Fatal("unique index should reject a second favorite for same user")
	}
}
