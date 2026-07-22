package web

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

const (
	desktopLyricsProtocol       = "melodex.desktop-lyrics.v1"
	desktopLyricsTokenProtocol  = "melodex-token."
	desktopLyricsMaxMessageSize = 512 << 10
	desktopLyricsSendBuffer     = 16
	desktopLyricsWriteTimeout   = 10 * time.Second
	desktopLyricsPongTimeout    = 60 * time.Second
	desktopLyricsPingInterval   = 25 * time.Second
)

type desktopLyricsEnvelope struct {
	Type         string            `json:"type"`
	Command      string            `json:"command,omitempty"`
	Track        json.RawMessage   `json:"track,omitempty"`
	Lyrics       []json.RawMessage `json:"lyrics,omitempty"`
	Position     float64           `json:"position,omitempty"`
	Duration     float64           `json:"duration,omitempty"`
	Paused       bool              `json:"paused,omitempty"`
	CurrentIndex int               `json:"current_index,omitempty"`
}

type desktopLyricsClient struct {
	conn        *websocket.Conn
	userID      uint
	deviceID    uint
	deviceEpoch int
	send        chan []byte
	done        chan struct{}
	stopOnce    sync.Once
}

func newDesktopLyricsClient(conn *websocket.Conn, userID, deviceID uint, deviceEpoch int) *desktopLyricsClient {
	return &desktopLyricsClient{
		conn:        conn,
		userID:      userID,
		deviceID:    deviceID,
		deviceEpoch: deviceEpoch,
		send:        make(chan []byte, desktopLyricsSendBuffer),
		done:        make(chan struct{}),
	}
}

func (c *desktopLyricsClient) stop() {
	if c == nil {
		return
	}
	c.stopOnce.Do(func() {
		close(c.done)
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

func (c *desktopLyricsClient) enqueue(message []byte) bool {
	if c == nil {
		return false
	}
	copyOfMessage := append([]byte(nil), message...)
	select {
	case <-c.done:
		return false
	case c.send <- copyOfMessage:
		return true
	default:
		return false
	}
}

func (c *desktopLyricsClient) writePump() {
	if c == nil || c.conn == nil {
		return
	}
	ticker := time.NewTicker(desktopLyricsPingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case message := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(desktopLyricsWriteTimeout))
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Printf("desktop lyrics websocket write failed: %v", err)
				c.stop()
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(desktopLyricsWriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("desktop lyrics websocket ping failed: %v", err)
				c.stop()
				return
			}
		}
	}
}

type desktopLyricsUserSession struct {
	browsers map[*desktopLyricsClient]time.Time
	devices  map[*desktopLyricsClient]struct{}
	active   *desktopLyricsClient
	track    []byte
	progress []byte
}

type desktopLyricsHubState struct {
	mu       sync.Mutex
	sessions map[uint]*desktopLyricsUserSession
}

var desktopLyricsHub = newDesktopLyricsHub()

func newDesktopLyricsHub() *desktopLyricsHubState {
	return &desktopLyricsHubState{sessions: make(map[uint]*desktopLyricsUserSession)}
}

func (h *desktopLyricsHubState) sessionLocked(userID uint) *desktopLyricsUserSession {
	session := h.sessions[userID]
	if session == nil {
		session = &desktopLyricsUserSession{
			browsers: make(map[*desktopLyricsClient]time.Time),
			devices:  make(map[*desktopLyricsClient]struct{}),
		}
		h.sessions[userID] = session
	}
	return session
}

func (h *desktopLyricsHubState) registerBrowser(client *desktopLyricsClient) {
	h.mu.Lock()
	h.sessionLocked(client.userID).browsers[client] = time.Time{}
	h.mu.Unlock()
}

func (h *desktopLyricsHubState) unregisterBrowser(client *desktopLyricsClient) {
	h.mu.Lock()
	session := h.sessions[client.userID]
	if session != nil {
		delete(session.browsers, client)
		if session.active == client {
			session.active = latestDesktopLyricsBrowser(session.browsers)
		}
	}
	h.mu.Unlock()
	client.stop()
}

func latestDesktopLyricsBrowser(browsers map[*desktopLyricsClient]time.Time) *desktopLyricsClient {
	var latest *desktopLyricsClient
	var latestAt time.Time
	for browser, sentAt := range browsers {
		if latest == nil || sentAt.After(latestAt) {
			latest = browser
			latestAt = sentAt
		}
	}
	return latest
}

func (h *desktopLyricsHubState) registerDevice(client *desktopLyricsClient) {
	h.mu.Lock()
	session := h.sessionLocked(client.userID)
	if len(session.track) > 0 && !client.enqueue(session.track) {
		h.mu.Unlock()
		client.stop()
		return
	}
	if len(session.progress) > 0 && !client.enqueue(session.progress) {
		h.mu.Unlock()
		client.stop()
		return
	}
	session.devices[client] = struct{}{}
	h.mu.Unlock()
}

func (h *desktopLyricsHubState) unregisterDevice(client *desktopLyricsClient) {
	h.mu.Lock()
	if session := h.sessions[client.userID]; session != nil {
		delete(session.devices, client)
	}
	h.mu.Unlock()
	client.stop()
}

func (h *desktopLyricsHubState) publishBrowserState(client *desktopLyricsClient, messageType string, message []byte, now time.Time) {
	var slow []*desktopLyricsClient
	h.mu.Lock()
	session := h.sessionLocked(client.userID)
	if _, exists := session.browsers[client]; !exists {
		h.mu.Unlock()
		return
	}
	session.browsers[client] = now
	session.active = client
	if messageType == "track" {
		session.track = append(session.track[:0], message...)
		// 切歌时旧曲 progress 已无意义；等浏览器发来新曲 progress 后再缓存。
		session.progress = nil
	} else {
		session.progress = append(session.progress[:0], message...)
	}
	for device := range session.devices {
		if !device.enqueue(message) {
			delete(session.devices, device)
			slow = append(slow, device)
		}
	}
	h.mu.Unlock()
	for _, device := range slow {
		device.stop()
	}
}

func (h *desktopLyricsHubState) routeDeviceCommand(client *desktopLyricsClient, message []byte) bool {
	var slow []*desktopLyricsClient
	delivered := false
	h.mu.Lock()
	session := h.sessions[client.userID]
	if session != nil {
		for session.active != nil {
			active := session.active
			if active.enqueue(message) {
				delivered = true
				break
			}
			delete(session.browsers, active)
			slow = append(slow, active)
			session.active = latestDesktopLyricsBrowser(session.browsers)
		}
	}
	h.mu.Unlock()
	for _, browser := range slow {
		browser.stop()
	}
	return delivered
}

func (h *desktopLyricsHubState) disconnectDevice(userID, deviceID uint) {
	var matches []*desktopLyricsClient
	h.mu.Lock()
	if session := h.sessions[userID]; session != nil {
		for device := range session.devices {
			if device.deviceID == deviceID {
				delete(session.devices, device)
				matches = append(matches, device)
			}
		}
	}
	h.mu.Unlock()
	for _, device := range matches {
		device.stop()
	}
}

func (h *desktopLyricsHubState) disconnectUser(userID uint) {
	var clients []*desktopLyricsClient
	h.mu.Lock()
	if session := h.sessions[userID]; session != nil {
		for browser := range session.browsers {
			clients = append(clients, browser)
		}
		for device := range session.devices {
			clients = append(clients, device)
		}
		delete(h.sessions, userID)
	}
	h.mu.Unlock()
	for _, client := range clients {
		client.stop()
	}
}

func validateDesktopLyricsBrowserMessage(message []byte) (desktopLyricsEnvelope, bool) {
	var envelope desktopLyricsEnvelope
	if len(message) == 0 || len(message) > desktopLyricsMaxMessageSize || json.Unmarshal(message, &envelope) != nil {
		return envelope, false
	}
	switch envelope.Type {
	case "track":
		if len(envelope.Lyrics) > 5000 {
			return envelope, false
		}
		return envelope, true
	case "progress":
		return envelope, len(message) <= 16<<10
	default:
		return envelope, false
	}
}

func validateDesktopLyricsDeviceMessage(message []byte) (desktopLyricsEnvelope, bool) {
	var envelope desktopLyricsEnvelope
	if len(message) == 0 || len(message) > 1024 || json.Unmarshal(message, &envelope) != nil || envelope.Type != "command" {
		return envelope, false
	}
	switch envelope.Command {
	case "prev", "toggle", "next":
		return envelope, true
	default:
		return envelope, false
	}
}

func desktopLyricsBrowserOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	return corsAllowedOrigins()[strings.ToLower(origin)]
}

func desktopLyricsTokenFromProtocols(r *http.Request) string {
	for _, raw := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		protocol := strings.TrimSpace(raw)
		if strings.HasPrefix(protocol, desktopLyricsTokenProtocol) {
			return strings.TrimPrefix(protocol, desktopLyricsTokenProtocol)
		}
	}
	return ""
}

func desktopLyricsBrowserWebSocketHandler(c *gin.Context) {
	upgrader := websocket.Upgrader{
		Subprotocols: []string{desktopLyricsProtocol},
		CheckOrigin:  desktopLyricsBrowserOriginAllowed,
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("desktop lyrics browser websocket upgrade failed: %v", err)
		return
	}
	client := newDesktopLyricsClient(conn, currentUserID(c), 0, 0)
	go client.writePump()
	desktopLyricsHub.registerBrowser(client)
	defer desktopLyricsHub.unregisterBrowser(client)
	readDesktopLyricsBrowser(client)
}

func readDesktopLyricsBrowser(client *desktopLyricsClient) {
	client.conn.SetReadLimit(desktopLyricsMaxMessageSize)
	_ = client.conn.SetReadDeadline(time.Now().Add(desktopLyricsPongTimeout))
	client.conn.SetPongHandler(func(string) error {
		return client.conn.SetReadDeadline(time.Now().Add(desktopLyricsPongTimeout))
	})
	for {
		messageType, message, err := client.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("desktop lyrics browser websocket read failed: %v", err)
			}
			return
		}
		if messageType != websocket.TextMessage {
			return
		}
		envelope, ok := validateDesktopLyricsBrowserMessage(message)
		if !ok {
			return
		}
		desktopLyricsHub.publishBrowserState(client, envelope.Type, message, time.Now())
	}
}

func desktopLyricsDeviceWebSocketHandler(c *gin.Context) {
	token := desktopLyricsTokenFromProtocols(c.Request)
	device, user, ok, err := authenticateDesktopLyricsDevice(token, time.Now())
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "设备鉴权失败"})
		return
	}
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "设备令牌无效"})
		return
	}
	upgrader := websocket.Upgrader{
		Subprotocols: []string{desktopLyricsProtocol},
		CheckOrigin:  func(*http.Request) bool { return true },
	}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("desktop lyrics device websocket upgrade failed: %v", err)
		return
	}
	client := newDesktopLyricsClient(conn, user.ID, device.ID, device.SessionEpoch)
	go client.writePump()
	desktopLyricsHub.registerDevice(client)
	defer desktopLyricsHub.unregisterDevice(client)
	readDesktopLyricsDevice(client)
}

func readDesktopLyricsDevice(client *desktopLyricsClient) {
	client.conn.SetReadLimit(1024)
	_ = client.conn.SetReadDeadline(time.Now().Add(desktopLyricsPongTimeout))
	client.conn.SetPongHandler(func(string) error {
		return client.conn.SetReadDeadline(time.Now().Add(desktopLyricsPongTimeout))
	})
	for {
		messageType, message, err := client.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("desktop lyrics device websocket read failed: %v", err)
			}
			return
		}
		if messageType != websocket.TextMessage {
			return
		}
		if _, ok := validateDesktopLyricsDeviceMessage(message); !ok {
			return
		}
		if !desktopLyricsDeviceStillValid(client.deviceID, client.userID, client.deviceEpoch) {
			return
		}
		if !desktopLyricsHub.routeDeviceCommand(client, message) {
			client.enqueue([]byte(`{"type":"error","code":"no_active_browser","message":"浏览器播放器未连接"}`))
		}
	}
}
