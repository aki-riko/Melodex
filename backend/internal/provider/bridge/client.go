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

type searchResponse struct {
	Songs []model.Track `json:"songs"`
	Error string        `json:"error,omitempty"`
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
