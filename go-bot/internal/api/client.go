package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/example/xray-cli-ts/go-bot/internal/models"
)

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func New(baseURL, apiKey string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *Client) ListProfiles(ctx context.Context) ([]models.Profile, error) {
	var out []models.Profile
	if err := c.doJSON(ctx, http.MethodGet, "/api/profiles", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetProfile(ctx context.Context, id int) (*models.Profile, error) {
	var out models.Profile
	if err := c.doJSON(ctx, http.MethodGet, "/api/profiles/"+strconv.Itoa(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateProfile(ctx context.Context, req CreateProfileRequest) (*models.Profile, error) {
	var out models.Profile
	if err := c.doJSON(ctx, http.MethodPost, "/api/profiles", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ToggleProfile(ctx context.Context, id int) (*models.ToggleResponse, error) {
	var out models.ToggleResponse
	if err := c.doJSON(ctx, http.MethodPatch, "/api/profiles/"+strconv.Itoa(id)+"/toggle", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteProfile(ctx context.Context, id int) error {
	return c.doJSON(ctx, http.MethodDelete, "/api/profiles/"+strconv.Itoa(id), nil, nil)
}

func (c *Client) GetInbounds(ctx context.Context) ([]models.Inbound, error) {
	var out []models.Inbound
	if err := c.doJSON(ctx, http.MethodGet, "/api/inbounds", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetProfileInbounds(ctx context.Context, id int) ([]string, error) {
	var out []string
	if err := c.doJSON(ctx, http.MethodGet, "/api/profiles/"+strconv.Itoa(id)+"/inbounds", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) AddProfileInbound(ctx context.Context, id int, tag string) error {
	body := map[string]string{"tag": tag}
	return c.doJSON(ctx, http.MethodPost, "/api/profiles/"+strconv.Itoa(id)+"/inbounds", body, nil)
}

func (c *Client) DeleteProfileInbound(ctx context.Context, id int, tag string) error {
	escaped := url.PathEscape(tag)
	return c.doJSON(ctx, http.MethodDelete, "/api/profiles/"+strconv.Itoa(id)+"/inbounds/"+escaped, nil, nil)
}

func (c *Client) GetSubscription(ctx context.Context, id int) (*models.SubscriptionResponse, error) {
	var out models.SubscriptionResponse
	if err := c.doJSON(ctx, http.MethodGet, "/api/profiles/"+strconv.Itoa(id)+"/subscription", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

type CreateProfileRequest struct {
	Username       string  `json:"username"`
	ServerAddress  string  `json:"server_address,omitempty"`
	Remark         string  `json:"remark,omitempty"`
	LimitGB        float64 `json:"limit_gb"`
	ExpireDays     int     `json:"expire_days"`
	AddAllInbounds bool    `json:"add_all_inbounds"`
}

type APIError struct {
	Status int
	Detail string
}

func (e *APIError) Error() string {
	if e.Detail != "" {
		return fmt.Sprintf("api status %d: %s", e.Status, e.Detail)
	}
	return fmt.Sprintf("api status %d", e.Status)
}

func (c *Client) doJSON(ctx context.Context, method, route string, reqBody any, out any) error {
	fullURL, err := c.joinURL(route)
	if err != nil {
		return err
	}

	var body io.Reader
	if reqBody != nil {
		buf := bytes.NewBuffer(nil)
		if err := json.NewEncoder(buf).Encode(reqBody); err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = buf
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("x-api-key", c.apiKey)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return decodeAPIError(resp)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func (c *Client) joinURL(route string) (string, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return "", fmt.Errorf("parse base URL: %w", err)
	}
	u.Path = path.Join(u.Path, route)
	return u.String(), nil
}

func decodeAPIError(resp *http.Response) error {
	payload := struct {
		Detail string `json:"detail"`
	}{}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if len(data) > 0 {
		_ = json.Unmarshal(data, &payload)
	}
	if payload.Detail == "" {
		payload.Detail = strings.TrimSpace(string(data))
	}
	return &APIError{Status: resp.StatusCode, Detail: payload.Detail}
}
