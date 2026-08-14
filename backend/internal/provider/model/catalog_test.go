package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCatalogJSONContract(t *testing.T) {
	track, err := json.Marshal(Track{
		ID:      "track-1",
		Name:    "Track",
		Artist:  "Artist",
		AlbumID: "album-1",
		Source:  "provider",
	})
	if err != nil {
		t.Fatalf("marshal track: %v", err)
	}
	for _, field := range []string{
		`"id":"track-1"`,
		`"name":"Track"`,
		`"artist":"Artist"`,
		`"album_id":"album-1"`,
		`"source":"provider"`,
	} {
		if !strings.Contains(string(track), field) {
			t.Fatalf("track JSON %s missing %s", track, field)
		}
	}

	collection, err := json.Marshal(RemoteCollection{
		ID:         "collection-1",
		Name:       "Collection",
		TrackCount: 12,
		Source:     "provider",
	})
	if err != nil {
		t.Fatalf("marshal collection: %v", err)
	}
	for _, field := range []string{
		`"id":"collection-1"`,
		`"name":"Collection"`,
		`"track_count":12`,
		`"source":"provider"`,
	} {
		if !strings.Contains(string(collection), field) {
			t.Fatalf("collection JSON %s missing %s", collection, field)
		}
	}
}
