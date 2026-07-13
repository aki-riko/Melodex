package qq

import (
	"encoding/json"
	"testing"
)

func TestQQAlbumSongDisplayNamePreservesVersionTitle(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "original duet",
			raw:  `{"mid":"001MPeqh1mdABU","name":"凝眸","title":"凝眸 (对唱版)"}`,
			want: "凝眸 (对唱版)",
		},
		{
			name: "instrumental",
			raw:  `{"mid":"000UWY2q4fCksJ","name":"凝眸","title":"凝眸 (对唱版伴奏)"}`,
			want: "凝眸 (对唱版伴奏)",
		},
		{
			name: "harmony instrumental",
			raw:  `{"mid":"0003q6YO4Xvxj6","name":"凝眸","title":"凝眸 (对唱版和声伴奏)"}`,
			want: "凝眸 (对唱版和声伴奏)",
		},
		{
			name: "legacy fallback",
			raw:  `{"mid":"legacy","name":"凝眸","title":""}`,
			want: "凝眸",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var song qqAlbumSongInfo
			if err := json.Unmarshal([]byte(tt.raw), &song); err != nil {
				t.Fatalf("decode QQ album song: %v", err)
			}
			if got := qqAlbumSongDisplayName(song); got != tt.want {
				t.Fatalf("display name = %q, want %q", got, tt.want)
			}
		})
	}
}
