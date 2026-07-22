package web

import (
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPlaybackTicketIsRedactedFromGinAccessLog(t *testing.T) {
	const signedTicket = "eyJ1aWQiOjF9.secret-signature"
	line := redactedGinLogFormatter(gin.LogFormatterParams{
		TimeStamp:  time.Unix(1_700_000_000, 0),
		StatusCode: 206,
		Latency:    25 * time.Millisecond,
		ClientIP:   "127.0.0.1",
		Method:     "GET",
		Path: RoutePrefix + "/download?id=2140404278&source=netease&stream=1&" +
			playbackTicketQueryName + "=" + signedTicket,
	})

	if strings.Contains(line, signedTicket) {
		t.Fatalf("access log leaked playback ticket: %s", line)
	}
	if !strings.Contains(line, playbackTicketQueryName+"="+redactedLogValue) {
		t.Fatalf("access log did not preserve a redacted ticket marker: %s", line)
	}
}

func TestMalformedPlaybackTicketQueryIsFullyRedacted(t *testing.T) {
	path := RoutePrefix + "/download?" + playbackTicketQueryName + "=secret%zz"
	redacted := redactPlaybackTicketPath(path)
	if strings.Contains(redacted, "secret") || !strings.Contains(redacted, redactedLogValue) {
		t.Fatalf("malformed query redaction = %q", redacted)
	}
}
