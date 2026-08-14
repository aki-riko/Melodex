package web

import (
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestSaveSongsToManualCollectionRollsBackOnInvalidTrack(t *testing.T) {
	initCollectionDBForTest(t)
	collection := Collection{
		UserID: testUserID, Name: "Atomic import", Kind: collectionKindManual,
		ContentType: collectionContentPlaylist, Source: localMusicSource,
	}
	if err := db.Create(&collection).Error; err != nil {
		t.Fatal(err)
	}

	added, err := saveSongsToManualCollection(collection.ID, []model.Track{
		{ID: "valid", Source: "qq", Name: "Valid"},
		{ID: "invalid", Source: "", Name: "Invalid"},
	})
	if err == nil {
		t.Fatal("saveSongsToManualCollection accepted an invalid track")
	}
	if added != 0 {
		t.Fatalf("added=%d, want 0 after rollback", added)
	}
	var count int64
	if err := db.Model(&SavedSong{}).Where("collection_id = ?", collection.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("saved song count=%d, want 0 after rollback", count)
	}
}
