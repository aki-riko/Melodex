package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/aki-riko/Melodex/backend/internal/provider/model"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
}

type SearchRequest struct {
	Source  string `json:"source"`
	Keyword string `json:"keyword"`
	Limit   int    `json:"limit,omitempty"`
	Cookie  string `json:"cookie,omitempty"`
	// SearchType 交给 sidecar 转给上游: 0=普通搜歌, 7=按歌词片段检索(QQ 原生支持)。
	SearchType int `json:"search_type,omitempty"`
}

type LyricRequest struct {
	Source string `json:"source"`
	ID     string `json:"id"`
	Cookie string `json:"cookie,omitempty"`
}

// ChorusRequest 是一次副歌点位查询。
//
// 只有 Source 参与上游选路, IDs 是**同源**的一批歌曲标识; 一次请求覆盖整页是硬要求
// (网易那条上游接口本身就是批量形态), 逐首请求会把一次列表刷新放大成上百次往返。
//
// KuwoHints 只在 kuwo 下有意义: 酷我没有"按 id 批量取副歌"的接口, sidecar 只能拿
// 歌名+歌手去反查, 而这两样只有 Go 侧(从 download_records)知道。键是 song_id,
// 值是"歌名 歌手"。其他源忽略该字段。
type ChorusRequest struct {
	Source    string            `json:"source"`
	IDs       []string          `json:"ids"`
	Cookie    string            `json:"cookie,omitempty"`
	KuwoHints map[string]string `json:"kuwo_hints,omitempty"`
}

// ChorusResponse 以歌曲 id 为键返回副歌点位。
//
// 用 map 而不是数组: 上游可能只覆盖批次里的一部分歌(网易实测 9~10/10),
// 用 map 让"这首没有数据"与"这次请求整体失败"天然可区分 —— 前者缺键, 后者直接是 error。
type ChorusResponse struct {
	Chorus map[string]model.ChorusPoint `json:"chorus"`
	Error  string                       `json:"error,omitempty"`
}

type CollectionRequest struct {
	Source     string `json:"source"`
	Action     string `json:"action"`
	Keyword    string `json:"keyword,omitempty"`
	ID         string `json:"id,omitempty"`
	Link       string `json:"link,omitempty"`
	CategoryID string `json:"category_id,omitempty"`
	Page       int    `json:"page,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	Cookie     string `json:"cookie,omitempty"`
}

type CollectionResponse struct {
	Collections []model.RemoteCollection `json:"collections,omitempty"`
	Songs       []model.Track            `json:"songs,omitempty"`
	Categories  []model.RemoteCategory   `json:"categories,omitempty"`
	Collection  *model.RemoteCollection  `json:"collection,omitempty"`
	Error       string                   `json:"error,omitempty"`
}

type AccountVerifyRequest struct {
	Source string `json:"source"`
	Cookie string `json:"cookie"`
}

type AccountVerifyResponse struct {
	VIP   bool   `json:"vip"`
	Error string `json:"error,omitempty"`
}

type QRCreateRequest struct {
	Source string `json:"source"`
}

type QRCheckRequest struct {
	Source string `json:"source"`
	Key    string `json:"key"`
}

type searchResponse struct {
	Songs []model.Track `json:"songs"`
	Error string        `json:"error,omitempty"`
	// RefreshedCookie 是 sidecar 自动续期后产生的新 cookie。QQ 的 musickey 只有 3 天
	// 寿命, 到期后 sidecar 用 cookie 里的长期凭据换出新 key 并把完整 cookie 回传, 这里
	// 据此持久化, 用户不必每 3~4 天重新扫码。为空表示本次没有发生续期。
	RefreshedCookie string `json:"refreshed_cookie,omitempty"`
	// EmptyReason 见 SearchResult.EmptyReason
	EmptyReason string `json:"empty_reason,omitempty"`
}

type lyricResponse struct {
	Lyric string `json:"lyric"`
	Error string `json:"error,omitempty"`
}

type qrCreateResponse struct {
	Challenge model.LoginChallenge `json:"challenge"`
	Error     string               `json:"error,omitempty"`
}

type qrCheckResponse struct {
	Result *model.LoginResult `json:"result"`
	Error  string             `json:"error,omitempty"`
}

func NewClient(rawBaseURL string, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawBaseURL))
	if err != nil {
		return nil, fmt.Errorf("parse provider URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("provider URL must use http or https")
	}
	if parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("provider URL must contain a host and no credentials")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{baseURL: parsed, httpClient: httpClient}, nil
}

// SearchResult 是一次搜索的完整结果。
type SearchResult struct {
	Songs []model.Track
	// RefreshedCookie 非空表示 sidecar 在本次请求中自动续期了该源的 cookie(目前只有 QQ
	// 会这样: musickey 3 天到期后由长期凭据换新), 调用方应把它持久化。
	RefreshedCookie string
	// EmptyReason 在 Songs 为空时说明原因, 便于上层给出"该等还是该换"的提示:
	//   rate_limited        上游限流(QQ code=2001)—— 等一会儿重试可能就好
	//   paid_or_unavailable 有候选但都取不到地址(付费曲/版权受限)—— 重试无用
	//   no_candidates       上游根本没返回候选
	// 为空表示 sidecar 未提供(非 QQ 源或旧版 sidecar)。
	EmptyReason string
}

func (c *Client) Search(ctx context.Context, request SearchRequest) ([]model.Track, error) {
	result, err := c.SearchWithRefresh(ctx, request)
	return result.Songs, err
}

// SearchWithRefresh 与 Search 相同, 但额外返回 sidecar 自动续期后的 cookie。
func (c *Client) SearchWithRefresh(ctx context.Context, request SearchRequest) (SearchResult, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.Keyword = strings.TrimSpace(request.Keyword)
	if request.Source == "" || request.Keyword == "" {
		return SearchResult{}, errors.New("provider search requires source and keyword")
	}
	body, err := json.Marshal(request)
	if err != nil {
		return SearchResult{}, fmt.Errorf("encode provider search: %w", err)
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: "/v1/search"})
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return SearchResult{}, fmt.Errorf("create provider search request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return SearchResult{}, fmt.Errorf("provider search request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return SearchResult{}, fmt.Errorf("read provider search response: %w", err)
	}
	var payload searchResponse
	if err := json.Unmarshal(raw, &payload); err != nil {
		return SearchResult{}, fmt.Errorf("decode provider search response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if payload.Error == "" {
			payload.Error = response.Status
		}
		return SearchResult{}, errors.New(payload.Error)
	}
	if payload.Songs == nil {
		payload.Songs = []model.Track{}
	}
	return SearchResult{
		Songs:           payload.Songs,
		RefreshedCookie: payload.RefreshedCookie,
		EmptyReason:     strings.TrimSpace(payload.EmptyReason),
	}, nil
}

func (c *Client) Lyric(ctx context.Context, request LyricRequest) (string, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.ID = strings.TrimSpace(request.ID)
	if request.Source == "" || request.ID == "" {
		return "", errors.New("provider lyric requires source and id")
	}
	var payload lyricResponse
	if err := c.postJSON(ctx, "/v1/lyric", request, &payload); err != nil {
		return "", err
	}
	if payload.Error != "" {
		return "", errors.New(payload.Error)
	}
	return strings.TrimSpace(payload.Lyric), nil
}

// Chorus 批量取一批**同源**歌曲的副歌点位。
//
// 只接受一个 source: 网易的批量接口只认自己的数字 id, 把多源 id 混在一条请求里
// 既没有语义也没法选路。IDs 为空时不发请求直接返回空 map —— 调用方(列表分页)
// 经常出现"这一页全是 QQ"的情况, 那时光是省掉一次往返就值得。
func (c *Client) Chorus(ctx context.Context, request ChorusRequest) (map[string]model.ChorusPoint, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.IDs = compactChorusIDs(request.IDs)
	if request.Source == "" {
		return nil, errors.New("provider chorus requires source")
	}
	if len(request.IDs) == 0 {
		return map[string]model.ChorusPoint{}, nil
	}
	var payload ChorusResponse
	if err := c.postJSON(ctx, "/v1/chorus", request, &payload); err != nil {
		return nil, err
	}
	if payload.Error != "" {
		return nil, errors.New(payload.Error)
	}
	// 只回传能自证合理的点位: 上游偶尔给出 start=0 或 end<start 的脏行,
	// 让它们在边界处消失, 比让前端各自兜底更安全。
	valid := make(map[string]model.ChorusPoint, len(payload.Chorus))
	for id, point := range payload.Chorus {
		key := strings.TrimSpace(id)
		if key == "" || !point.Valid() {
			continue
		}
		valid[key] = point
	}
	return valid, nil
}

// compactChorusIDs 去空白、去空串并保持首次出现顺序的去重。
//
// 顺序要保留: 上游对超长 id 列表会截断, 调用方按页内顺序送进来时,
// 截断丢掉的总是"排在后面"的那几首, 行为可预期。
func compactChorusIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func (c *Client) Collections(ctx context.Context, request CollectionRequest) (CollectionResponse, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.Action = strings.TrimSpace(request.Action)
	if request.Source == "" || request.Action == "" {
		return CollectionResponse{}, errors.New("provider collection requires source and action")
	}
	var payload CollectionResponse
	if err := c.postJSON(ctx, "/v1/collections", request, &payload); err != nil {
		return CollectionResponse{}, err
	}
	if payload.Collections == nil {
		payload.Collections = []model.RemoteCollection{}
	}
	if payload.Songs == nil {
		payload.Songs = []model.Track{}
	}
	if payload.Categories == nil {
		payload.Categories = []model.RemoteCategory{}
	}
	return payload, nil
}

func (c *Client) VerifyAccount(ctx context.Context, request AccountVerifyRequest) (bool, error) {
	request.Source = strings.TrimSpace(request.Source)
	if request.Source == "" || strings.TrimSpace(request.Cookie) == "" {
		return false, errors.New("provider account verification requires source and cookie")
	}
	var payload AccountVerifyResponse
	if err := c.postJSON(ctx, "/v1/account/verify", request, &payload); err != nil {
		return false, err
	}
	if payload.Error != "" {
		return false, errors.New(payload.Error)
	}
	return payload.VIP, nil
}

func (c *Client) QRCreate(ctx context.Context, request QRCreateRequest) (*model.LoginChallenge, error) {
	request.Source = strings.TrimSpace(request.Source)
	if request.Source == "" {
		return nil, errors.New("provider QR login requires source")
	}
	var payload qrCreateResponse
	if err := c.postJSON(ctx, "/v1/qr/create", request, &payload); err != nil {
		return nil, err
	}
	return &payload.Challenge, nil
}

func (c *Client) QRCheck(ctx context.Context, request QRCheckRequest) (*model.LoginResult, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.Key = strings.TrimSpace(request.Key)
	if request.Source == "" || request.Key == "" {
		return nil, errors.New("provider QR login requires source and key")
	}
	var payload qrCheckResponse
	if err := c.postJSON(ctx, "/v1/qr/check", request, &payload); err != nil {
		return nil, err
	}
	return payload.Result, nil
}

func (c *Client) postJSON(ctx context.Context, path string, request any, target any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encode provider request: %w", err)
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path})
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create provider request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return fmt.Errorf("provider request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return fmt.Errorf("read provider response: %w", err)
	}
	var envelope struct {
		Error string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode provider response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if envelope.Error == "" {
			envelope.Error = response.Status
		}
		return errors.New(envelope.Error)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode provider response: %w", err)
	}
	return nil
}
