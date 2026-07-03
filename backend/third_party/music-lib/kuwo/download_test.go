package kuwo

import "testing"

func TestKuwoPreferredDownloadQualitiesHighToLow(t *testing.T) {
	got := kuwoPreferredDownloadQualities()
	want := []string{"2000kflac", "flac", "320kmp3", "128kmp3"}
	if len(got) != len(want) {
		t.Fatalf("quality count = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("quality[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestFirstReachableKuwoAudioURLSkipsBadCandidates(t *testing.T) {
	got := firstReachableKuwoAudioURL([]string{"", "bad-flac", "good-320"}, func(rawURL string) bool {
		return rawURL == "good-320"
	})
	if got != "good-320" {
		t.Fatalf("reachable url = %q, want good-320", got)
	}
}
