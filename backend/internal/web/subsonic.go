// Subsonic API facade —— TuneScout+ 自实现的轻量 Subsonic 服务端。
//
// 设计目标:让音流(substreamer)等标准 Subsonic 客户端直接连 TuneScout+ 一个地址,
// 即可「搜全网在线听 + 浏览已下载本地曲库 + 听过自动入库」。
//
//   - search3      → 接 go-music-dl 联网搜索,验活后返回能播的结果(全网搜)
//   - stream       → 本地已有走本地文件;否则在线解析播放 + 后台完整下载落盘入库
//   - getCoverArt  → 本地嵌入封面优先,否则代理在线封面
//   - 曲库浏览      → 扫共享下载目录(复用 local_music 扫描)生成专辑/艺人/歌曲
//
// 协议:Subsonic REST API,响应版本固定 1.16.1,支持 xml/json/jsonp。
// 认证:u + t=md5(password+salt) + s(salt),凭据从 env 读(默认关,配凭据才启用)。
//
// 安全:facade 默认关闭(MUSIC_DL_SUBSONIC_ENABLED 未开则所有 /rest 返回未启用);
// 启用后所有端点强制 Subsonic 认证;反代/落盘复用现有 SSRF 防护。
package web

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// subsonicAPIVersion 是 facade 对外宣称的 Subsonic 协议版本。
// 报 1.16.1(最新),支持 token 认证(1.13.0+)。
const subsonicAPIVersion = "1.16.1"

// subsonicConfig 是从环境变量解析出的 facade 配置(进程启动时读一次)。
type subsonicConfig struct {
	Enabled  bool
	User     string
	Password string
}

var (
	subsonicConfigOnce  sync.Once
	subsonicConfigCache subsonicConfig
)

// getSubsonicConfig 读取并缓存 facade 配置。禁止硬编码,凭据走 env:
//   - MUSIC_DL_SUBSONIC_ENABLED:设为 1/true/on 才启用(默认关)
//   - MUSIC_DL_SUBSONIC_USER:Subsonic 客户端登录用户名
//   - MUSIC_DL_SUBSONIC_PASS:Subsonic 客户端登录密码(强密码)
//
// 未配置 user/pass 时即使 ENABLED 也视为未启用(无凭据=不可认证,安全)。
func getSubsonicConfig() subsonicConfig {
	subsonicConfigOnce.Do(func() {
		subsonicConfigCache = loadSubsonicConfigFromEnv()
	})
	return subsonicConfigCache
}

// loadSubsonicConfigFromEnv 是纯函数,便于单测(不走 once 缓存)。
func loadSubsonicConfigFromEnv() subsonicConfig {
	enabled := parseEnvBool(os.Getenv("MUSIC_DL_SUBSONIC_ENABLED"))
	user := strings.TrimSpace(os.Getenv("MUSIC_DL_SUBSONIC_USER"))
	pass := strings.TrimSpace(os.Getenv("MUSIC_DL_SUBSONIC_PASS"))
	// 凭据缺失则强制关闭:无法认证的 facade 不应暴露任何端点。
	if user == "" || pass == "" {
		enabled = false
	}
	return subsonicConfig{Enabled: enabled, User: user, Password: pass}
}

// parseEnvBool 解析常见的布尔环境变量写法。
func parseEnvBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "on", "yes", "y":
		return true
	default:
		return false
	}
}

// subsonicError 是 Subsonic 错误码(取协议文档常用子集)。
type subsonicError struct {
	Code    int
	Message string
}

var (
	errSubsonicMissingParam = subsonicError{Code: 10, Message: "Required parameter is missing"}
	errSubsonicBadAuth      = subsonicError{Code: 40, Message: "Wrong username or password"}
	errSubsonicNotFound     = subsonicError{Code: 70, Message: "The requested data was not found"}
	errSubsonicDisabled     = subsonicError{Code: 0, Message: "Subsonic API is not enabled on this server"}
)

// verifySubsonicToken 校验 salt+token 认证:token == md5(password+salt)。
// 也兼容明文密码(p,含 enc: 十六进制前缀),供调试/旧客户端使用。
func verifySubsonicToken(cfg subsonicConfig, user, token, salt, plainPass string) bool {
	if cfg.User == "" || cfg.Password == "" {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(user), cfg.User) {
		return false
	}
	// token 方案(推荐):md5(password+salt) 小写十六进制。
	if token != "" && salt != "" {
		sum := md5.Sum([]byte(cfg.Password + salt))
		expected := hex.EncodeToString(sum[:])
		return strings.EqualFold(strings.TrimSpace(token), expected)
	}
	// 明文方案(p):支持 enc:<hex> 形式。
	if plainPass != "" {
		if strings.HasPrefix(plainPass, "enc:") {
			if decoded, err := hex.DecodeString(strings.TrimPrefix(plainPass, "enc:")); err == nil {
				return string(decoded) == cfg.Password
			}
			return false
		}
		return plainPass == cfg.Password
	}
	return false
}

// subsonicResponse 是所有非二进制端点的根包裹元素 <subsonic-response>。
// payload 由各端点填充(如 searchResult3 / license / error)。
// XML 与 JSON 共用此结构;JSON 时整体再包一层 {"subsonic-response": ...}。
type subsonicResponse struct {
	XMLName xml.Name `xml:"subsonic-response" json:"-"`
	Xmlns   string   `xml:"xmlns,attr" json:"-"`
	Status  string   `xml:"status,attr" json:"status"`
	Version string   `xml:"version,attr" json:"version"`

	Error         *subsonicErrorBody `xml:"error,omitempty" json:"error,omitempty"`
	License       *subsonicLicense   `xml:"license,omitempty" json:"license,omitempty"`
	SearchResult3 *searchResult3Body `xml:"searchResult3,omitempty" json:"searchResult3,omitempty"`
	MusicFolders  *musicFoldersBody  `xml:"musicFolders,omitempty" json:"musicFolders,omitempty"`
	Indexes       *indexesBody       `xml:"indexes,omitempty" json:"indexes,omitempty"`
	Artists       *artistsBody       `xml:"artists,omitempty" json:"artists,omitempty"`
	Artist        *artistBody        `xml:"artist,omitempty" json:"artist,omitempty"`
	Album         *albumBody         `xml:"album,omitempty" json:"album,omitempty"`
	AlbumList2    *albumList2Body    `xml:"albumList2,omitempty" json:"albumList2,omitempty"`
	Lyrics        *lyricsBody        `xml:"lyrics,omitempty" json:"lyrics,omitempty"`
}

type subsonicErrorBody struct {
	Code    int    `xml:"code,attr" json:"code"`
	Message string `xml:"message,attr" json:"message"`
}

type subsonicLicense struct {
	Valid bool `xml:"valid,attr" json:"valid"`
}

// newSubsonicOK 构造一个 status=ok 的空响应,供各端点填充 payload 字段。
func newSubsonicOK() *subsonicResponse {
	return &subsonicResponse{
		Xmlns:   "http://subsonic.org/restapi",
		Status:  "ok",
		Version: subsonicAPIVersion,
	}
}

// respondSubsonic 按客户端请求的格式(f=xml|json|jsonp)序列化响应。
// 默认 xml(协议默认)。jsonp 用 callback 参数包裹。
func respondSubsonic(c *gin.Context, resp *subsonicResponse) {
	format := strings.ToLower(strings.TrimSpace(c.Query("f")))
	switch format {
	case "json":
		c.JSON(http.StatusOK, gin.H{"subsonic-response": resp})
	case "jsonp":
		callback := strings.TrimSpace(c.Query("callback"))
		if callback == "" {
			callback = "callback"
		}
		// 手动包裹 JSONP:callback({"subsonic-response": ...});
		payload, err := json.Marshal(gin.H{"subsonic-response": resp})
		if err != nil {
			c.Status(http.StatusInternalServerError)
			return
		}
		c.Header("Content-Type", "application/javascript; charset=utf-8")
		c.String(http.StatusOK, "%s(%s)", callback, string(payload))
	default:
		c.XML(http.StatusOK, resp)
	}
}

// respondSubsonicError 返回 status=failed + <error code message>。
// HTTP 状态码仍用 200(Subsonic 约定:错误在 body 里表达)。
func respondSubsonicError(c *gin.Context, e subsonicError) {
	resp := newSubsonicOK()
	resp.Status = "failed"
	resp.Error = &subsonicErrorBody{Code: e.Code, Message: e.Message}
	respondSubsonic(c, resp)
}

// ===== Subsonic payload 元素定义(xml attr + json field 双标签) =====

// subsonicChild 是 Subsonic 的通用「歌曲/媒体项」元素(song/child)。
type subsonicChild struct {
	ID          string `xml:"id,attr" json:"id"`
	Parent      string `xml:"parent,attr,omitempty" json:"parent,omitempty"`
	IsDir       bool   `xml:"isDir,attr" json:"isDir"`
	Title       string `xml:"title,attr" json:"title"`
	Album       string `xml:"album,attr,omitempty" json:"album,omitempty"`
	Artist      string `xml:"artist,attr,omitempty" json:"artist,omitempty"`
	CoverArt    string `xml:"coverArt,attr,omitempty" json:"coverArt,omitempty"`
	Duration    int    `xml:"duration,attr,omitempty" json:"duration,omitempty"`
	BitRate     int    `xml:"bitRate,attr,omitempty" json:"bitRate,omitempty"`
	Size        int64  `xml:"size,attr,omitempty" json:"size,omitempty"`
	Suffix      string `xml:"suffix,attr,omitempty" json:"suffix,omitempty"`
	ContentType string `xml:"contentType,attr,omitempty" json:"contentType,omitempty"`
	Type        string `xml:"type,attr,omitempty" json:"type,omitempty"`
	AlbumID     string `xml:"albumId,attr,omitempty" json:"albumId,omitempty"`
	ArtistID    string `xml:"artistId,attr,omitempty" json:"artistId,omitempty"`
}

type searchResult3Body struct {
	Artists []subsonicArtist `xml:"artist" json:"artist,omitempty"`
	Albums  []subsonicAlbum  `xml:"album" json:"album,omitempty"`
	Songs   []subsonicChild  `xml:"song" json:"song,omitempty"`
}

type subsonicArtist struct {
	ID         string `xml:"id,attr" json:"id"`
	Name       string `xml:"name,attr" json:"name"`
	CoverArt   string `xml:"coverArt,attr,omitempty" json:"coverArt,omitempty"`
	AlbumCount int    `xml:"albumCount,attr,omitempty" json:"albumCount,omitempty"`
}

type subsonicAlbum struct {
	ID        string          `xml:"id,attr" json:"id"`
	Name      string          `xml:"name,attr" json:"name"`
	Artist    string          `xml:"artist,attr,omitempty" json:"artist,omitempty"`
	ArtistID  string          `xml:"artistId,attr,omitempty" json:"artistId,omitempty"`
	CoverArt  string          `xml:"coverArt,attr,omitempty" json:"coverArt,omitempty"`
	SongCount int             `xml:"songCount,attr,omitempty" json:"songCount,omitempty"`
	Songs     []subsonicChild `xml:"song" json:"song,omitempty"`
}

type musicFoldersBody struct {
	MusicFolders []subsonicMusicFolder `xml:"musicFolder" json:"musicFolder"`
}

type subsonicMusicFolder struct {
	ID   int    `xml:"id,attr" json:"id"`
	Name string `xml:"name,attr" json:"name"`
}

type indexesBody struct {
	LastModified int64           `xml:"lastModified,attr" json:"lastModified"`
	Index        []subsonicIndex `xml:"index" json:"index,omitempty"`
}

type artistsBody struct {
	Index []subsonicIndex `xml:"index" json:"index,omitempty"`
}

type subsonicIndex struct {
	Name    string           `xml:"name,attr" json:"name"`
	Artists []subsonicArtist `xml:"artist" json:"artist,omitempty"`
}

type artistBody struct {
	subsonicArtist
	Albums []subsonicAlbum `xml:"album" json:"album,omitempty"`
}

type albumBody struct {
	subsonicAlbum
}

type albumList2Body struct {
	Albums []subsonicAlbum `xml:"album" json:"album,omitempty"`
}

type lyricsBody struct {
	Artist string `xml:"artist,attr,omitempty" json:"artist,omitempty"`
	Title  string `xml:"title,attr,omitempty" json:"title,omitempty"`
	Value  string `xml:",chardata" json:"value,omitempty"`
}

// RegisterSubsonicRoutes 注册 Subsonic facade 路由,挂在标准前缀 /rest 下。
// 直接挂到 raw engine(不走 /music 管理员鉴权);facade 自带 Subsonic 认证。
// facade 默认关闭:未配置凭据时所有端点返回「未启用」错误。
func RegisterSubsonicRoutes(r *gin.Engine) {
	rest := r.Group("/rest")
	rest.Use(subsonicAuthMiddleware())

	// 系统/握手端点
	rest.GET("/ping", subsonicPing)
	rest.GET("/ping.view", subsonicPing)
	rest.GET("/getLicense", subsonicGetLicense)
	rest.GET("/getLicense.view", subsonicGetLicense)
}

// subsonicAuthMiddleware 校验 facade 是否启用 + Subsonic 认证(u/t/s 或 u/p)。
// ping 等端点也要求认证(标准客户端在 ping 时即带凭据探测)。
func subsonicAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		cfg := getSubsonicConfig()
		if !cfg.Enabled {
			respondSubsonicError(c, errSubsonicDisabled)
			c.Abort()
			return
		}
		user := c.Query("u")
		token := c.Query("t")
		salt := c.Query("s")
		plain := c.Query("p")
		if user == "" || (token == "" && plain == "") {
			respondSubsonicError(c, errSubsonicMissingParam)
			c.Abort()
			return
		}
		if !verifySubsonicToken(cfg, user, token, salt, plain) {
			respondSubsonicError(c, errSubsonicBadAuth)
			c.Abort()
			return
		}
		c.Next()
	}
}

// subsonicPing 连通性探测:返回空 ok 响应。
func subsonicPing(c *gin.Context) {
	respondSubsonic(c, newSubsonicOK())
}

// subsonicGetLicense 返回永久有效 license(否则客户端认为试用过期拒绝使用)。
func subsonicGetLicense(c *gin.Context) {
	resp := newSubsonicOK()
	resp.License = &subsonicLicense{Valid: true}
	respondSubsonic(c, resp)
}
