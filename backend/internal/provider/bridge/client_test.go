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

func TestCollectionQRAndAccountContracts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		switch r.URL.Path {
		case "/v1/collections":
			_ = json.NewEncoder(w).Encode(CollectionResponse{
				Collections: []model.RemoteCollection{{ID: "collection-1", Source: "netease"}},
				Songs:       []model.Track{{ID: "song-1", Source: "netease"}},
			})
		case "/v1/qr/create":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"challenge": model.LoginChallenge{Provider: "netease", ChallengeID: "key-1"},
			})
		case "/v1/qr/check":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"result": model.LoginResult{Provider: "netease", ChallengeID: "key-1", Phase: model.LoginSucceeded},
			})
		case "/v1/account/verify":
			_ = json.NewEncoder(w).Encode(AccountVerifyResponse{VIP: true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}

	collections, err := client.Collections(context.Background(), CollectionRequest{
		Source: "netease", Action: "playlist", ID: "collection-1",
	})
	if err != nil || len(collections.Collections) != 1 || len(collections.Songs) != 1 {
		t.Fatalf("collections = %#v, err=%v", collections, err)
	}
	challenge, err := client.QRCreate(context.Background(), QRCreateRequest{Source: "netease"})
	if err != nil || challenge.ChallengeID != "key-1" {
		t.Fatalf("challenge = %#v, err=%v", challenge, err)
	}
	result, err := client.QRCheck(context.Background(), QRCheckRequest{Source: "netease", Key: "key-1"})
	if err != nil || result.Phase != model.LoginSucceeded {
		t.Fatalf("result = %#v, err=%v", result, err)
	}
	vip, err := client.VerifyAccount(context.Background(), AccountVerifyRequest{Source: "netease", Cookie: "MUSIC_U=test"})
	if err != nil || !vip {
		t.Fatalf("vip = %v, err=%v", vip, err)
	}
}
