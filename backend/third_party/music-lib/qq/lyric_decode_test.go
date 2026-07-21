package qq

import (
	"os"
	"strings"
	"testing"

	"github.com/guohuiyuan/music-lib/model"
)

func TestParseQQDecryptedLyricFallsBackToLineLRC(t *testing.T) {
	const realQQPayload = `[00:01.23]演唱：婴戏浅戈
[00:07.37]如初见 你从桥边折枝缓缓来
[00:12.34]迟来花信墨痕洇透谁的等待`

	tags, data := parseQQDecryptedLyric(realQQPayload)
	if len(tags) != 0 {
		t.Fatalf("unexpected tags: %#v", tags)
	}
	if len(data) != 3 {
		t.Fatalf("parsed line count = %d, want 3", len(data))
	}
	if got := data[1].Words[0].Text; !strings.Contains(got, "如初见") {
		t.Fatalf("second line = %q, want real lyric text", got)
	}
}

func TestParseQQDecryptedLyricStillAcceptsQRC(t *testing.T) {
	const qrc = `<Lyric_1 LyricType="1" LyricContent="[1000,1000]你(1000,500)好(1500,500)"/>`

	_, data := parseQQDecryptedLyric(qrc)
	if len(data) != 1 || len(data[0].Words) != 2 {
		t.Fatalf("unexpected qrc data: %#v", data)
	}
}

func TestQQRealSpringLetterLyric(t *testing.T) {
	if os.Getenv("MUSIC_LIB_LIVE_QQ_LYRIC") != "1" {
		t.Skip("set MUSIC_LIB_LIVE_QQ_LYRIC=1 to run the live QQ lyric check")
	}

	song := &model.Song{
		ID:       "00498DKO1STwWZ",
		Source:   "qq",
		Name:     "春信迟",
		Artist:   "婴戏浅戈",
		Album:    "春信迟",
		Duration: 274,
		Extra: map[string]string{
			"song_id": "585226910",
			"songmid": "00498DKO1STwWZ",
		},
	}
	lyric, err := New("").GetLyrics(song)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"如初见 你从桥边折枝缓缓来", "迟来花信墨痕洇透谁的等待"} {
		if !strings.Contains(lyric, want) {
			t.Fatalf("live lyric missing %q: %.300s", want, lyric)
		}
	}
}
