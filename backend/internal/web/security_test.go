package web

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// download_cover 对内网/环回 URL 应返回 403(SSRF 防护)。
func TestDownloadCoverRejectsSSRF(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterMusicRoutes(r.Group(RoutePrefix))

	for _, u := range []string{
		"http://127.0.0.1/x.jpg",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:8329/",
		"http://10.0.0.1/a",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/download_cover?url="+u, nil)
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("download_cover url=%s status=%d, want 403", u, rec.Code)
		}
	}
}

// 改密码后,旧会话(旧 epoch)应失效。
func TestSessionRevokedOnPasswordChange(t *testing.T) {
	setupUserTestDB(t)
	u, err := createUser("alice", "alicepass1", RoleUser)
	if err != nil {
		t.Fatalf("createUser: %v", err)
	}
	now := time.Now()
	value, err := createUserSession(u, now)
	if err != nil {
		t.Fatalf("createUserSession: %v", err)
	}

	mkReq := func() *gin.Context {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.AddCookie(&http.Cookie{Name: authCookieName, Value: value})
		c.Request = req
		return c
	}

	// 改密前:旧 cookie 有效
	if _, ok := authenticateRequest(mkReq(), now.Add(time.Minute)); !ok {
		t.Fatal("session should be valid before password change")
	}

	// 改密码(epoch+1)
	if err := setUserPassword(u.ID, "newpass99"); err != nil {
		t.Fatalf("setUserPassword: %v", err)
	}

	// 改密后:旧 cookie 失效
	if _, ok := authenticateRequest(mkReq(), now.Add(time.Minute)); ok {
		t.Fatal("old session should be revoked after password change")
	}
}

func TestLocalAudioStreamOwnership(t *testing.T) {
	setupUserTestDB(t)
	alice, _ := createUser("alice", "alicepass1", RoleUser)
	bob, _ := createUser("bob", "bobpass1", RoleUser)

	dir := t.TempDir()
	withLocalMusicDownloadDir(t, dir)
	rel := "alice-song.mp3"
	if err := os.WriteFile(filepath.Join(dir, rel), []byte("ID3audio-bytes-padding-xxxxxxxxxx"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	recordDownload(alice.ID, rel, localMusicSource, "x", "S", "A")
	invalidateLocalMusicScanCache()

	// 解析出该 track 的 id(base64 relPath)
	tracks, _, _, _, _, _ := scanLocalMusicTracksCached(true)
	if len(tracks) == 0 {
		t.Fatal("track not scanned")
	}
	id := tracks[0].ID

	routerFor := func(uid uint, admin bool) *gin.Engine {
		gin.SetMode(gin.TestMode)
		r := gin.New()
		grp := r.Group(RoutePrefix)
		grp.Use(func(c *gin.Context) {
			c.Set(ctxUserID, uid)
			c.Set(ctxUserRole, map[bool]string{true: RoleAdmin, false: RoleUser}[admin])
			c.Next()
		})
		RegisterMusicRoutes(grp)
		return r
	}

	// bob(非归属)→ 404
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/download?source="+localMusicSource+"&id="+id, nil)
	routerFor(bob.ID, false).ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("bob stream status=%d, want 404", rec.Code)
	}

	// alice(归属)→ 非 404
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, RoutePrefix+"/download?source="+localMusicSource+"&id="+id, nil)
	routerFor(alice.ID, false).ServeHTTP(rec, req)
	if rec.Code == http.StatusNotFound {
		t.Fatalf("alice (owner) should access her file, got 404")
	}
}

func TestJSONReadRoutesRequireLogin(t *testing.T) {
	setupUserTestDB(t)
	if _, err := createUser("root", "rootpass1", RoleAdmin); err != nil {
		t.Fatalf("create root: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
	req.Header.Set("Accept", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous /api/v1/search status=%d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

func TestJSONReadRoutesAllowDesktopMode(t *testing.T) {
	setupUserTestDB(t)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterJSONAPIRoutes(r, StartOptions{DisableAuth: true})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sources", nil)
	req.Header.Set("Accept", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("desktop /api/v1/sources status=%d, want 200, body=%s", rec.Code, rec.Body.String())
	}
}

func TestMusicRoutesRequireLogin(t *testing.T) {
	setupUserTestDB(t)
	if _, err := createUser("root", "rootpass1", RoleAdmin); err != nil {
		t.Fatalf("create root: %v", err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	group := r.Group(RoutePrefix)
	group.Use(authRequired())
	RegisterMusicRoutes(group)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, RoutePrefix+"/inspect?id=x&source=qq", nil)
	req.Header.Set("Accept", "application/json")
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous /music/inspect status=%d, want 401, body=%s", rec.Code, rec.Body.String())
	}
}

// clearWriteDeadline 对不支持 SetWriteDeadline 的 writer(httptest.Recorder)
// 必须静默降级,不 panic —— 保证非真实连接路径(单测)不受影响。
func TestClearWriteDeadlineGracefulOnUnsupportedWriter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodGet, "/x", nil)

	// 不应 panic。
	clearWriteDeadline(c)

	// nil context / nil writer 也不应 panic。
	clearWriteDeadline(nil)
	clearWriteDeadline(&gin.Context{})
}

// 真实连接端到端:普通接口受 server.WriteTimeout 约束(慢写被截断),
// 音频流接口调 clearWriteDeadline 后不受约束(慢写仍成功送达)。
func TestWriteTimeoutHonoredExceptForStreamEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 普通接口:写前 sleep 超过 WriteTimeout。
	r.GET("/normal", func(c *gin.Context) {
		time.Sleep(400 * time.Millisecond)
		c.String(http.StatusOK, "NORMAL_OK")
	})
	// 流接口:解除写截止后再 sleep,应能送达。
	r.GET("/stream", func(c *gin.Context) {
		clearWriteDeadline(c)
		time.Sleep(400 * time.Millisecond)
		c.String(http.StatusOK, "STREAM_OK")
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv := &http.Server{Handler: r, WriteTimeout: 150 * time.Millisecond}
	go srv.Serve(ln)
	t.Cleanup(func() { _ = srv.Close() })
	addr := ln.Addr().String()

	get := func(path string) (string, error) {
		conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			return "", err
		}
		defer conn.Close()
		fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", path)
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		body, _ := io.ReadAll(bufio.NewReader(conn))
		return string(body), nil
	}

	// 普通接口:WriteTimeout 到期,连接被服务端关闭 → 拿不到完整 body。
	normalResp, err := get("/normal")
	if err != nil {
		t.Fatalf("normal request: %v", err)
	}
	if strings.Contains(normalResp, "NORMAL_OK") {
		t.Fatalf("normal endpoint should be cut by WriteTimeout, but got full body: %q", normalResp)
	}

	// 流接口:clearWriteDeadline 解除限制 → 慢写仍送达完整 body。
	streamResp, err := get("/stream")
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	if !strings.Contains(streamResp, "STREAM_OK") {
		t.Fatalf("stream endpoint should bypass WriteTimeout, but body missing marker: %q", streamResp)
	}
}
