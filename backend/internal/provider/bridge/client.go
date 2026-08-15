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

func (c *Client) Search(ctx context.Context, request SearchRequest) ([]model.Track, error) {
	request.Source = strings.TrimSpace(request.Source)
	request.Keyword = strings.TrimSpace(request.Keyword)
	if request.Source == "" || request.Keyword == "" {
		return nil, errors.New("provider search requires source and keyword")
	}
	body, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("encode provider search: %w", err)
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: "/v1/search"})
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create provider search request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("provider search request: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return nil, fmt.Errorf("read provider search response: %w", err)
	}
	var payload searchResponse
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("decode provider search response: %w", err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if payload.Error == "" {
			payload.Error = response.Status
		}
		return nil, errors.New(payload.Error)
	}
	if payload.Songs == nil {
		payload.Songs = []model.Track{}
	}
	return payload.Songs, nil
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
