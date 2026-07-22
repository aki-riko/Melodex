package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

func setupDesktopLyricsTestDB(t *testing.T) {
	t.Helper()
	resetDesktopLyricsRuntimeForTest()
	t.Cleanup(resetDesktopLyricsRuntimeForTest)
	setupUserTestDB(t)
}

func pairDesktopLyricsTestDevice(t *testing.T, user *User, name string) desktopLyricsPairResponse {
	t.Helper()
	code, _, err := createDesktopLyricsPairing(user.ID, user.SessionEpoch, time.Now())
	if err != nil {
		t.Fatalf("create pairing: %v", err)
	}
	paired, err := pairDesktopLyricsDevice(desktopLyricsPairRequest{Code: code, DeviceName: name}, time.Now())
	if err != nil {
		t.Fatalf("pair device: %v", err)
	}
	return paired
}

func TestDesktopLyricsPairingStoresOnlyTokenHashAndIsSingleUse(t *testing.T) {
	setupDesktopLyricsTestDB(t)
	u, err := createUser("lyrics-user", "secret123", RoleUser)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	code, expiresAt, err := createDesktopLyricsPairing(u.ID, u.SessionEpoch, time.Now())
	if err != nil {
		t.Fatalf("create pairing: %v", err)
	}
	if len(normalizeDesktopLyricsPairCode(code)) != 16 || time.Until(expiresAt) <= 0 {
		t.Fatalf("unexpected pairing code or expiry: code=%q expires=%v", code, expiresAt)
	}

	paired, err := pairDesktopLyricsDevice(desktopLyricsPairRequest{Code: strings.ToLower(code), DeviceName: " Windows 11 "}, time.Now())
	if err != nil {
		t.Fatalf("pair device: %v", err)
	}
	if paired.DeviceID == 0 || paired.DeviceToken == "" || paired.DeviceName != "Windows 11" {
		t.Fatalf("unexpected pair response: %+v", paired)
	}
	var stored DesktopLyricsDevice
	if err := db.First(&stored, paired.DeviceID).Error; err != nil {
		t.Fatalf("load stored device: %v", err)
	}
	if stored.TokenHash == paired.DeviceToken || stored.TokenHash != desktopLyricsTokenHash(paired.DeviceToken) {
		t.Fatal("database must contain only the device token hash")
	}
	if _, err := pairDesktopLyricsDevice(desktopLyricsPairRequest{Code: code, DeviceName: "replay"}, time.Now()); err == nil {
		t.Fatal("pairing code must be single use")
	}
	device, authenticatedUser, ok, err := authenticateDesktopLyricsDevice(paired.DeviceToken, time.Now())
	if err != nil || !ok || device.ID != paired.DeviceID || authenticatedUser.ID != u.ID {
		t.Fatalf("authenticate paired device: device=%+v user=%+v ok=%v err=%v", device, authenticatedUser, ok, err)
	}
}

func TestDesktopLyricsDeviceRevokedByPasswordChangeAndDeletion(t *testing.T) {
	setupDesktopLyricsTestDB(t)
	root, err := createUser("lyrics-root", "secret123", RoleAdmin)
	if err != nil {
		t.Fatalf("create root: %v", err)
	}
	u, err := createUser("lyrics-member", "secret123", RoleUser)
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	paired := pairDesktopLyricsTestDevice(t, u, "MacBook")
	if err := setUserPassword(u.ID, "changed123"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	if _, _, ok, err := authenticateDesktopLyricsDevice(paired.DeviceToken, time.Now()); err != nil || ok {
		t.Fatalf("old device token must be revoked after password change: ok=%v err=%v", ok, err)
	}
	var revokedCount int64
	if err := db.Model(&DesktopLyricsDevice{}).Where("user_id = ?", u.ID).Count(&revokedCount).Error; err != nil || revokedCount != 0 {
		t.Fatalf("password change must delete stale device credentials: count=%d err=%v", revokedCount, err)
	}

	reloaded, err := findUserByID(u.ID)
	if err != nil {
		t.Fatalf("reload member: %v", err)
	}
	paired = pairDesktopLyricsTestDevice(t, reloaded, "Windows")
	if err := deleteUserAndData(u.ID); err != nil {
		t.Fatalf("delete member: %v", err)
	}
	var deviceCount int64
	if err := db.Model(&DesktopLyricsDevice{}).Where("user_id = ?", u.ID).Count(&deviceCount).Error; err != nil {
		t.Fatalf("count devices: %v", err)
	}
	if deviceCount != 0 {
		t.Fatalf("deleted user devices remain: %d", deviceCount)
	}
	if _, _, ok, err := authenticateDesktopLyricsDevice(paired.DeviceToken, time.Now()); err != nil || ok {
		t.Fatalf("deleted user token must be invalid: ok=%v err=%v", ok, err)
	}
	_ = root
}

func TestDesktopLyricsHubIsolationActiveBrowserAndSlowClient(t *testing.T) {
	hub := newDesktopLyricsHub()
	browserA := newDesktopLyricsClient(nil, 1, 0, 0)
	browserB := newDesktopLyricsClient(nil, 1, 0, 0)
	otherBrowser := newDesktopLyricsClient(nil, 2, 0, 0)
	device := newDesktopLyricsClient(nil, 1, 10, 0)
	otherDevice := newDesktopLyricsClient(nil, 2, 20, 0)
	hub.registerBrowser(browserA)
	hub.registerBrowser(browserB)
	hub.registerBrowser(otherBrowser)
	hub.registerDevice(device)
	hub.registerDevice(otherDevice)

	trackA := []byte(`{"type":"track","track":{"name":"A"},"lyrics":[]}`)
	hub.publishBrowserState(browserA, "track", trackA, time.Unix(1, 0))
	if got := string(<-device.send); got != string(trackA) {
		t.Fatalf("user device received wrong track: %s", got)
	}
	select {
	case got := <-otherDevice.send:
		t.Fatalf("cross-user state leaked: %s", got)
	default:
	}

	trackB := []byte(`{"type":"track","track":{"name":"B"},"lyrics":[]}`)
	hub.publishBrowserState(browserB, "track", trackB, time.Unix(2, 0))
	<-device.send
	command := []byte(`{"type":"command","command":"next"}`)
	if !hub.routeDeviceCommand(device, command) {
		t.Fatal("active browser should receive the device command")
	}
	if got := string(<-browserB.send); got != string(command) {
		t.Fatalf("last active browser received wrong command: %s", got)
	}
	select {
	case got := <-browserA.send:
		t.Fatalf("inactive browser received command: %s", got)
	default:
	}

	lateDevice := newDesktopLyricsClient(nil, 1, 11, 0)
	hub.registerDevice(lateDevice)
	if got := string(<-lateDevice.send); got != string(trackB) {
		t.Fatalf("late device did not receive cached track: %s", got)
	}

	slowDevice := newDesktopLyricsClient(nil, 1, 12, 0)
	hub.registerDevice(slowDevice)
	<-slowDevice.send // 丢弃注册时重放的 track，随后故意填满有限缓冲。
	for i := 0; i <= desktopLyricsSendBuffer; i++ {
		message := []byte(`{"type":"progress","position":1}`)
		hub.publishBrowserState(browserB, "progress", message, time.Unix(int64(3+i), 0))
	}
	select {
	case <-slowDevice.done:
	default:
		t.Fatal("slow device should be disconnected after its finite buffer fills")
	}
}

func TestDesktopLyricsWebSocketReplaysStateAndRoutesControls(t *testing.T) {
	setupDesktopLyricsTestDB(t)
	u, err := createUser("ws-user", "secret123", RoleUser)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	paired := pairDesktopLyricsTestDevice(t, u, "Integration")

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/browser", func(c *gin.Context) {
		setCurrentUser(c, u)
		desktopLyricsBrowserWebSocketHandler(c)
	})
	router.GET("/device", desktopLyricsDeviceWebSocketHandler)
	server := httptest.NewServer(router)
	defer server.Close()
	wsBase := "ws" + strings.TrimPrefix(server.URL, "http")

	browserDialer := websocket.Dialer{Subprotocols: []string{desktopLyricsProtocol}}
	browser, response, err := browserDialer.Dial(wsBase+"/browser", http.Header{"Origin": []string{server.URL}})
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("dial browser websocket: status=%d err=%v", status, err)
	}
	defer browser.Close()
	track := []byte(`{"type":"track","track":{"id":"1","name":"晴天","artist":"周杰伦"},"lyrics":[{"t":0,"end":3,"text":"故事的小黄花"}],"position":1,"duration":269,"paused":false,"current_index":0}`)
	if err := browser.WriteMessage(websocket.TextMessage, track); err != nil {
		t.Fatalf("send browser track: %v", err)
	}

	deviceDialer := websocket.Dialer{Subprotocols: []string{desktopLyricsProtocol, desktopLyricsTokenProtocol + paired.DeviceToken}}
	device, response, err := deviceDialer.Dial(wsBase+"/device", nil)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("dial device websocket: status=%d err=%v", status, err)
	}
	defer device.Close()
	_ = device.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, replayed, err := device.ReadMessage()
	if err != nil {
		t.Fatalf("read replayed track: %v", err)
	}
	var replayedEnvelope desktopLyricsEnvelope
	if err := json.Unmarshal(replayed, &replayedEnvelope); err != nil || replayedEnvelope.Type != "track" {
		t.Fatalf("unexpected replayed state: %s err=%v", replayed, err)
	}

	command := []byte(`{"type":"command","command":"toggle"}`)
	if err := device.WriteMessage(websocket.TextMessage, command); err != nil {
		t.Fatalf("send device command: %v", err)
	}
	_ = browser.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, routed, err := browser.ReadMessage()
	if err != nil {
		t.Fatalf("read routed command: %v", err)
	}
	if string(routed) != string(command) {
		t.Fatalf("unexpected routed command: %s", routed)
	}

	badDialer := websocket.Dialer{Subprotocols: []string{desktopLyricsProtocol, desktopLyricsTokenProtocol + "invalid"}}
	bad, response, err := badDialer.Dial(wsBase+"/device", nil)
	if bad != nil {
		_ = bad.Close()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid token websocket should be rejected with 401: status=%v err=%v", response, err)
	}
}

func TestDesktopLyricsMessageValidation(t *testing.T) {
	if _, ok := validateDesktopLyricsBrowserMessage([]byte(`{"type":"track","track":null,"lyrics":[]}`)); !ok {
		t.Fatal("valid track message rejected")
	}
	if _, ok := validateDesktopLyricsBrowserMessage([]byte(`{"type":"command","command":"next"}`)); ok {
		t.Fatal("browser must not send commands")
	}
	if _, ok := validateDesktopLyricsDeviceMessage([]byte(`{"type":"command","command":"prev"}`)); !ok {
		t.Fatal("valid device command rejected")
	}
	if _, ok := validateDesktopLyricsDeviceMessage([]byte(`{"type":"command","command":"seek"}`)); ok {
		t.Fatal("device must not gain undeclared control capability")
	}
}
