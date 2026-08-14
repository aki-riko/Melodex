package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	rangeProbeEnd         int64 = 15
	initialRangeChunkSize int64 = 32 * 1024
	regularRangeChunkSize int64 = 256 * 1024
	maximumRangeWorkers         = 16
	rangeChunkAttempts          = 3
)

type SourceRangeFetch struct {
	ContentLength int64
	Total         int64
	Start         int64
	End           int64
	StatusCode    int
	URL           string
	Source        string
	ContentRange  string
	ContentType   string
	Ext           string
}

type rangeChunk struct {
	start int64
	end   int64
	index int
}

type rangeChunkResult struct {
	data  []byte
	err   error
	index int
}

func FetchBytesWithMime(urlString, source string) ([]byte, string, error) {
	fetch, ranged, err := NewSourceRangeFetch(urlString, source, "")
	if err != nil {
		return nil, "", err
	}
	if !ranged {
		return fetchBytesSingle(urlString, source)
	}

	var output bytes.Buffer
	if fetch.ContentLength > 0 && fetch.ContentLength <= int64(int(^uint(0)>>1)) {
		output.Grow(int(fetch.ContentLength))
	}
	if err := fetch.WriteTo(&output); err != nil {
		return nil, "", err
	}
	return output.Bytes(), fetch.ContentType, nil
}

func FetchResourceBytesWithMime(urlString, source string) ([]byte, string, error) {
	return fetchBytesSingle(urlString, source)
}

func fetchBytesSingle(urlString, source string) ([]byte, string, error) {
	request, err := BuildSourceRequest(http.MethodGet, urlString, source, "")
	if err != nil {
		return nil, "", err
	}
	response, err := (&http.Client{
		Timeout:       2 * time.Minute,
		CheckRedirect: checkPublicRedirect,
	}).Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, "", fmt.Errorf("upstream returned %s", response.Status)
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, "", err
	}
	contentType := normalizedContentType(response.Header.Get("Content-Type"))
	if contentType == "" && len(data) > 0 {
		contentType = normalizedContentType(http.DetectContentType(data))
	}
	return data, contentType, nil
}

func NewSourceRangeFetch(urlString, source, requestedRange string) (*SourceRangeFetch, bool, error) {
	probeRange := fmt.Sprintf("bytes=0-%d", rangeProbeEnd)
	request, err := BuildSourceRequest(http.MethodGet, urlString, source, probeRange)
	if err != nil {
		return nil, false, err
	}
	response, err := (&http.Client{Timeout: 30 * time.Second, CheckRedirect: checkPublicRedirect}).Do(request)
	if err != nil {
		return nil, false, nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusPartialContent {
		return nil, false, nil
	}

	total, validTotal := parseContentRangeTotal(response.Header.Get("Content-Range"))
	if !validTotal || total <= 0 {
		return nil, false, nil
	}
	if total > int64(int(^uint(0)>>1)) {
		return nil, true, fmt.Errorf("download too large: %d bytes", total)
	}
	probe, err := io.ReadAll(io.LimitReader(response.Body, rangeProbeEnd+1))
	if err != nil {
		return nil, true, err
	}
	contentType := normalizedContentType(response.Header.Get("Content-Type"))
	if !LooksLikeAudioData(contentType, probe) {
		return nil, true, fmt.Errorf("upstream range response is not audio: %s", contentType)
	}
	extension := DetectAudioExtBySignature(probe)
	if extension == "" {
		extension = DetectAudioExtByContentType(contentType)
	}
	if extension != "" && (contentType == "" || contentType == "application/octet-stream") {
		contentType = AudioMimeByExt(extension)
	}

	start, end, partial, validRange := resolveRangeHeader(requestedRange, total)
	if !validRange {
		return nil, true, fmt.Errorf("invalid range: %s", requestedRange)
	}
	fetch := newSourceRangeFetch(urlString, source, contentType, extension, start, end, total)
	if partial {
		fetch.StatusCode = http.StatusPartialContent
		fetch.ContentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, total)
	}
	return fetch, true, nil
}

func newSourceRangeFetch(urlString, source, contentType, extension string, start, end, total int64) *SourceRangeFetch {
	return &SourceRangeFetch{
		ContentLength: end - start + 1,
		Total:         total,
		Start:         start,
		End:           end,
		StatusCode:    http.StatusOK,
		URL:           urlString,
		Source:        source,
		ContentType:   contentType,
		Ext:           extension,
	}
}

func (fetch *SourceRangeFetch) WriteTo(writer io.Writer) error {
	if fetch == nil {
		return errors.New("nil range fetch")
	}
	return transferRange(writer, fetch.URL, fetch.Source, fetch.Start, fetch.End)
}

func transferRange(writer io.Writer, urlString, source string, start, end int64) error {
	if end < start {
		return nil
	}
	chunks := planRangeChunks(start, end, initialRangeChunkSize, regularRangeChunkSize)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	workerSlots := make(chan struct{}, maximumRangeWorkers)
	results := make(chan rangeChunkResult, len(chunks))

	for _, chunk := range chunks {
		chunk := chunk
		go func() {
			select {
			case workerSlots <- struct{}{}:
			case <-ctx.Done():
				return
			}
			data, err := fetchRangeChunk(ctx, urlString, source, chunk.start, chunk.end)
			<-workerSlots
			select {
			case results <- rangeChunkResult{index: chunk.index, data: data, err: err}:
			case <-ctx.Done():
			}
		}()
	}

	next := 0
	pending := make(map[int]rangeChunkResult)
	for next < len(chunks) {
		result := <-results
		if result.err != nil {
			cancel()
			return result.err
		}
		pending[result.index] = result
		for {
			ready, exists := pending[next]
			if !exists {
				break
			}
			if _, err := writer.Write(ready.data); err != nil {
				cancel()
				return err
			}
			if flusher, ok := writer.(http.Flusher); ok {
				flusher.Flush()
			}
			delete(pending, next)
			next++
		}
	}
	return nil
}

func planRangeChunks(start, end, firstSize, regularSize int64) []rangeChunk {
	if end < start || firstSize <= 0 || regularSize <= 0 {
		return nil
	}
	firstEnd := min(end, start+firstSize-1)
	chunks := []rangeChunk{{index: 0, start: start, end: firstEnd}}
	for chunkStart := firstEnd + 1; chunkStart <= end; chunkStart += regularSize {
		chunks = append(chunks, rangeChunk{
			index: len(chunks),
			start: chunkStart,
			end:   min(end, chunkStart+regularSize-1),
		})
	}
	return chunks
}

func fetchRangeChunk(ctx context.Context, urlString, source string, start, end int64) ([]byte, error) {
	var lastError error
	for attempt := 0; attempt < rangeChunkAttempts; attempt++ {
		request, err := BuildSourceRequest(http.MethodGet, urlString, source, fmt.Sprintf("bytes=%d-%d", start, end))
		if err != nil {
			return nil, err
		}
		request = request.WithContext(ctx)
		response, err := (&http.Client{Timeout: 90 * time.Second, CheckRedirect: checkPublicRedirect}).Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastError = err
			continue
		}
		data, readError := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusPartialContent && response.StatusCode != http.StatusOK {
			lastError = fmt.Errorf("range %d-%d returned %s", start, end, response.Status)
			continue
		}
		if readError != nil {
			lastError = readError
			continue
		}
		expectedLength := end - start + 1
		if int64(len(data)) != expectedLength {
			lastError = fmt.Errorf("range %d-%d returned %d bytes, want %d", start, end, len(data), expectedLength)
			continue
		}
		return data, nil
	}
	return nil, lastError
}

func parseContentRangeTotal(value string) (int64, bool) {
	_, totalText, found := strings.Cut(strings.TrimSpace(value), "/")
	if !found || totalText == "*" {
		return 0, false
	}
	total, err := strconv.ParseInt(strings.TrimSpace(totalText), 10, 64)
	return total, err == nil && total > 0
}

func resolveRangeHeader(value string, total int64) (start, end int64, partial, valid bool) {
	if total <= 0 {
		return 0, 0, false, false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, total - 1, false, true
	}
	unit, specification, found := strings.Cut(value, "=")
	if !found || !strings.EqualFold(strings.TrimSpace(unit), "bytes") || strings.Contains(specification, ",") {
		return 0, 0, false, false
	}
	left, right, found := strings.Cut(strings.TrimSpace(specification), "-")
	if !found {
		return 0, 0, false, false
	}
	left, right = strings.TrimSpace(left), strings.TrimSpace(right)
	if left == "" {
		suffix, err := strconv.ParseInt(right, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false, false
		}
		suffix = min(suffix, total)
		return total - suffix, total - 1, true, true
	}

	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= total {
		return 0, 0, false, false
	}
	if right == "" {
		return start, total - 1, true, true
	}
	end, err = strconv.ParseInt(right, 10, 64)
	if err != nil || end < start {
		return 0, 0, false, false
	}
	return start, min(end, total-1), true, true
}

func normalizedContentType(value string) string {
	mediaType, _, _ := strings.Cut(strings.TrimSpace(value), ";")
	return strings.ToLower(strings.TrimSpace(mediaType))
}

func checkPublicRedirect(request *http.Request, previous []*http.Request) error {
	if len(previous) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	host := request.URL.Hostname()
	if host == "" {
		return errors.New("redirect to empty host blocked")
	}
	addresses, err := net.LookupIP(host)
	if err != nil || len(addresses) == 0 {
		if literal := net.ParseIP(host); literal != nil {
			addresses = []net.IP{literal}
		} else {
			return errors.New("redirect host unresolvable")
		}
	}
	for _, address := range addresses {
		if blockedRedirectAddress(address) {
			return errors.New("redirect to blocked address")
		}
	}
	return nil
}

func blockedRedirectAddress(address net.IP) bool {
	if address == nil || address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() || address.IsUnspecified() || address.IsMulticast() {
		return true
	}
	ipv4 := address.To4()
	return ipv4 != nil && ipv4[0] == 169 && ipv4[1] == 254
}
