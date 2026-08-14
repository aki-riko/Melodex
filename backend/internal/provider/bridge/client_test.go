package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

func TestSearchMapsProviderResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/search" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		var request SearchRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Source != "netease" || request.Keyword != "周杰伦 晴天" {
			t.Fatalf("unexpected payload: %#v", request)
		}
		_ = json.NewEncoder(w).Encode(searchResponse{Songs: []model.Track{{
			ID: "song-1", Source: "netease", Name: "晴天", Artist: "周杰伦",
		}}})
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	songs, err := client.Search(context.Background(), SearchRequest{
		Source: "netease", Keyword: "周杰伦 晴天",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(songs) != 1 || songs[0].ID != "song-1" || songs[0].Artist != "周杰伦" {
		t.Fatalf("unexpected songs: %#v", songs)
	}
}

func TestSearchReturnsProviderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(searchResponse{Error: "upstream unavailable"})
	}))
	defer server.Close()
	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Search(context.Background(), SearchRequest{Source: "qq", Keyword: "test"})
	if err == nil || err.Error() != "upstream unavailable" {
		t.Fatalf("unexpected error: %v", err)
	}
}
