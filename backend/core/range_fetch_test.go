package core

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestSourceRangeFetchWriteToReturnsWrittenBytes(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), 4096)
	server := newRangeTestServer(t, data)
	defer server.Close()

	fetch := &SourceRangeFetch{
		URL: server.URL, Start: 0, End: int64(len(data) - 1),
	}
	var output bytes.Buffer
	written, err := fetch.WriteTo(&output)
	if err != nil {
		t.Fatalf("WriteTo() error = %v", err)
	}
	if written != int64(len(data)) {
		t.Fatalf("WriteTo() wrote %d bytes, want %d", written, len(data))
	}
	if !bytes.Equal(output.Bytes(), data) {
		t.Fatal("WriteTo() output differs from source data")
	}
}

func TestSourceRangeFetchWriteToRejectsShortWrite(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), 4096)
	server := newRangeTestServer(t, data)
	defer server.Close()

	fetch := &SourceRangeFetch{
		URL: server.URL, Start: 0, End: int64(len(data) - 1),
	}
	written, err := fetch.WriteTo(shortWriter{})
	if !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("WriteTo() error = %v, want io.ErrShortWrite", err)
	}
	if written <= 0 || written >= int64(len(data)) {
		t.Fatalf("WriteTo() wrote %d bytes after short write, want partial count", written)
	}
}

func TestSourceRangeFetchWriteToNilReceiver(t *testing.T) {
	var fetch *SourceRangeFetch
	written, err := fetch.WriteTo(io.Discard)
	if err == nil || !strings.Contains(err.Error(), "nil range fetch") {
		t.Fatalf("WriteTo() error = %v, want nil range fetch error", err)
	}
	if written != 0 {
		t.Fatalf("WriteTo() wrote %d bytes for nil receiver, want 0", written)
	}
}

type shortWriter struct{}

func (shortWriter) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	return len(data) / 2, nil
}

func newRangeTestServer(t *testing.T, data []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeValue := r.Header.Get("Range")
		if !strings.HasPrefix(rangeValue, "bytes=") {
			http.Error(w, "missing range", http.StatusBadRequest)
			return
		}
		parts := strings.Split(strings.TrimPrefix(rangeValue, "bytes="), "-")
		if len(parts) != 2 {
			http.Error(w, "invalid range", http.StatusBadRequest)
			return
		}
		start, startErr := strconv.Atoi(parts[0])
		end, endErr := strconv.Atoi(parts[1])
		if startErr != nil || endErr != nil || start < 0 || end < start || end >= len(data) {
			http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", "bytes "+strconv.Itoa(start)+"-"+strconv.Itoa(end)+"/"+strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[start : end+1])
	}))
}
