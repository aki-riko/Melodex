package web

import (
	"reflect"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestArtistTokenizationAndExactFilterContract(t *testing.T) {
	for _, tc := range []struct {
		artist string
		want   []string
	}{
		{"周杰伦", []string{"周杰伦"}},
		{"周杰伦/杨瑞代", []string{"周杰伦", "杨瑞代"}},
		{"Taylor Swift feat. Ed Sheeran", []string{"Taylor Swift", "Ed Sheeran"}},
		{"周杰伦、周杰伦、杨瑞代", []string{"周杰伦", "杨瑞代"}},
		{"周杰伦-、Asasblue", []string{"周杰伦", "Asasblue"}},
		{"AC/DC", []string{"AC/DC"}},
	} {
		if got := splitArtistTokens(tc.artist); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("artist tokens for %q = %v, want %v", tc.artist, got, tc.want)
		}
	}

	tracks := []model.Track{{Name: "Song A", Artist: "周杰伦/杨瑞代"}, {Name: "Song B", Artist: "周杰伦"}, {Name: "Song C", Artist: "张学友"}, {Name: "Song D", Artist: "AC/DC"}}
	wantJay := []model.Track{{Name: "Song A", Artist: "周杰伦/杨瑞代"}, {Name: "Song B", Artist: "周杰伦"}}
	if got := filterSongsByExactArtist(tracks, " 周杰伦 "); !reflect.DeepEqual(got, wantJay) {
		t.Fatalf("Jay exact filter = %#v", got)
	}
	wantACDC := []model.Track{{Name: "Song D", Artist: "AC/DC"}}
	if got := filterSongsByExactArtist(tracks, "ac/dc"); !reflect.DeepEqual(got, wantACDC) {
		t.Fatalf("AC/DC exact filter = %#v", got)
	}
}

func TestAlbumIdentityAndMatchingContract(t *testing.T) {
	for _, tc := range []struct {
		track model.Track
		want  string
	}{
		{model.Track{AlbumID: "123", Extra: map[string]string{"album_id": "456"}}, "123"},
		{model.Track{Extra: map[string]string{"album_id": "456"}}, "456"},
		{model.Track{Extra: map[string]string{"albumMid": "mid-456"}}, "mid-456"},
		{model.Track{}, ""},
	} {
		if got := songAlbumID(tc.track); got != tc.want {
			t.Fatalf("album ID for %#v = %q, want %q", tc.track, got, tc.want)
		}
	}
	albums := []model.RemoteCollection{{ID: "1", Name: "稻香", Creator: "其他歌手"}, {ID: "2", Name: "稻香", Creator: "周杰伦"}, {ID: "3", Name: "我很忙", Creator: "周杰伦"}}
	match := pickBestAlbumMatch("稻香", "周杰伦-、Asasblue", albums)
	if match == nil || match.ID != "2" {
		t.Fatalf("best album match = %#v", match)
	}
}
