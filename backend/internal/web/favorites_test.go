package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func newFavoriteTestRouter(uid uint) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	grp := r.Group(RoutePrefix)
	grp.Use(func(c *gin.Context) {
		c.Set(ctxUserID, uid)
		c.Set(ctxUserRole, RoleUser)
		c.Next()
	})
	RegisterFavoriteRoutes(grp)
	RegisterCollectionRoutes(grp)
	return r
}

func TestFavoriteToggleAndStatus(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	r := newFavoriteTestRouter(alice.ID)

	body := `{"id":"s1","source":"qq","name":"测试歌","artist":"歌手","album":"测试专辑","album_id":"album-1","cover":"c","duration":200}`

	// 初始未收藏
	rec := doJSON(r, http.MethodGet, RoutePrefix+"/favorites/status?source=qq&id=s1", nil, nil)
	if rec.Code != 200 || rec.Body.String() != `{"favorited":false}` {
		t.Fatalf("initial status = %s", rec.Body.String())
	}

	// toggle → 收藏
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, RoutePrefix+"/favorites/toggle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Body.String() != `{"favorited":true}` {
		t.Fatalf("toggle on = %d %s", rec.Code, rec.Body.String())
	}

	// status → 已收藏
	rec = doJSON(r, http.MethodGet, RoutePrefix+"/favorites/status?source=qq&id=s1", nil, nil)
	if rec.Body.String() != `{"favorited":true}` {
		t.Fatalf("status after add = %s", rec.Body.String())
	}

	// 「我喜欢」歌单已自动创建且含该歌
	fav, err := ensureFavoriteCollection(alice.ID)
	if err != nil {
		t.Fatalf("ensureFavoriteCollection: %v", err)
	}
	if fav.Kind != collectionKindFavorite || fav.Name != favoriteCollectionName {
		t.Fatalf("favorite collection wrong: %+v", fav)
	}
	var n int64
	db.Model(&SavedSong{}).Where("collection_id = ?", fav.ID).Count(&n)
	if n != 1 {
		t.Fatalf("favorite should have 1 song, got %d", n)
	}
	var saved SavedSong
	if err := db.Where("collection_id = ?", fav.ID).First(&saved).Error; err != nil {
		t.Fatalf("load favorite song: %v", err)
	}
	extra := decodeSongExtraMap(saved.Extra)
	if extraMapValue(extra, "album") != "测试专辑" || extraMapValue(extra, "album_id") != "album-1" {
		t.Fatalf("favorite extra album = %#v, want album metadata", extra)
	}

	// toggle again → 取消
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, RoutePrefix+"/favorites/toggle", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Body.String() != `{"favorited":false}` {
		t.Fatalf("toggle off = %s", rec.Body.String())
	}
	db.Model(&SavedSong{}).Where("collection_id = ?", fav.ID).Count(&n)
	if n != 0 {
		t.Fatalf("favorite should be empty after un-toggle, got %d", n)
	}
}

func TestFavoriteStatusBatch(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	r := newFavoriteTestRouter(alice.ID)

	rec := doJSON(r, http.MethodPost, RoutePrefix+"/favorites/toggle", map[string]string{
		"id": "s1", "source": "qq", "name": "Song 1",
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("toggle status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doJSON(r, http.MethodPost, RoutePrefix+"/favorites/status_batch", gin.H{
		"songs": []gin.H{
			{"id": "s1", "source": "qq"},
			{"id": "s2", "source": "qq"},
			{"id": "s1", "source": "qq"},
			{"id": "", "source": "qq"},
		},
	}, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("batch status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Statuses []favoriteStatusItem `json:"statuses"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode batch response: %v", err)
	}
	if len(got.Statuses) != 2 {
		t.Fatalf("batch statuses len = %d, want 2: %#v", len(got.Statuses), got.Statuses)
	}
	statusByKey := map[string]bool{}
	for _, item := range got.Statuses {
		statusByKey[favoritePairKey(item.Source, item.SongID)] = item.Favorited
	}
	if !statusByKey[favoritePairKey("qq", "s1")] {
		t.Fatalf("s1 should be favorited: %#v", got.Statuses)
	}
	if statusByKey[favoritePairKey("qq", "s2")] {
		t.Fatalf("s2 should not be favorited: %#v", got.Statuses)
	}
}

func TestFavoriteCollectionNotDeletable(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	r := newFavoriteTestRouter(alice.ID)
	fav, _ := ensureFavoriteCollection(alice.ID)

	rec := doJSON(r, http.MethodDelete, RoutePrefix+"/collections/"+uintToStr(fav.ID), nil, nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("deleting favorite should be 400, got %d", rec.Code)
	}
	// 仍存在
	if _, err := ensureFavoriteCollection(alice.ID); err != nil {
		t.Fatalf("favorite should still exist: %v", err)
	}
}

func TestNewUserGetsFavoriteCollection(t *testing.T) {
	setupUserTestDB(t)
	u, err := createUser("bob", "bobpass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	var n int64
	db.Model(&Collection{}).Where("user_id = ? AND kind = ?", u.ID, collectionKindFavorite).Count(&n)
	if n != 1 {
		t.Fatalf("new user should have exactly 1 favorite collection, got %d", n)
	}
}
