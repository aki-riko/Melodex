package web

import (
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

	body := `{"id":"s1","source":"qq","name":"测试歌","artist":"歌手","cover":"c","duration":200}`

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
