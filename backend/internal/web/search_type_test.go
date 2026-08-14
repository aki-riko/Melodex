package web

import (
	"reflect"
	"testing"

	"github.com/aki-riko/Melodex/backend/core"
	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestDefaultSourcesForSearchType(t *testing.T) {
	wantAlbum := core.GetAlbumSourceNames()
	if got := defaultSourcesForSearchType("album"); !reflect.DeepEqual(got, wantAlbum) {
		t.Fatalf("defaultSourcesForSearchType(album) = %v, want %v", got, wantAlbum)
	}

	if got := defaultSourcesForSearchType("playlist"); len(got) == 0 {
		t.Fatal("defaultSourcesForSearchType(playlist) returned empty sources")
	}

	if got := defaultSourcesForSearchType("song"); len(got) == 0 {
		t.Fatal("defaultSourcesForSearchType(song) returned empty sources")
	}

	if got := defaultSourcesForSearchType("lyric"); !reflect.DeepEqual(got, core.GetLyricSearchSourceNames()) {
		t.Fatalf("defaultSourcesForSearchType(lyric) = %v, want lyric search sources", got)
	}
}

func TestPrioritizeAlbumsBySourcePutsCredentialedSourceFirst(t *testing.T) {
	albums := []model.Playlist{
		{ID: "kg-1", Name: "永夜星河 影视原声大碟", Source: "kugou"},
		{ID: "kw-1", Name: "永夜星河", Source: "kuwo"},
		{ID: "qq-1", Name: "永夜星河 影视原声大碟", Source: "qq"},
		{ID: "qq-2", Name: "永夜星河", Source: "qq"},
		{ID: "ne-1", Name: "永夜星河 影视原声大碟", Source: "netease"},
	}

	prioritizeAlbumsBySource(
		albums,
		[]string{"netease", "qq", "kugou", "kuwo"},
		map[string]string{"qq": "saved credential"},
	)

	wantIDs := []string{"qq-1", "qq-2", "ne-1", "kg-1", "kw-1"}
	gotIDs := make([]string, 0, len(albums))
	for _, album := range albums {
		gotIDs = append(gotIDs, album.ID)
	}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("prioritized album IDs = %v, want %v", gotIDs, wantIDs)
	}
}

func TestPrioritizeAlbumsBySourceUsesRequestedOrderWithoutCredentials(t *testing.T) {
	albums := []model.Playlist{
		{ID: "kg-1", Source: "kugou"},
		{ID: "qq-1", Source: "qq"},
		{ID: "ne-1", Source: "netease"},
		{ID: "qq-2", Source: "qq"},
	}

	prioritizeAlbumsBySource(albums, []string{"netease", "qq", "kugou"}, nil)

	wantIDs := []string{"ne-1", "qq-1", "qq-2", "kg-1"}
	gotIDs := make([]string, 0, len(albums))
	for _, album := range albums {
		gotIDs = append(gotIDs, album.ID)
	}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("album IDs without credentials = %v, want %v", gotIDs, wantIDs)
	}
}
