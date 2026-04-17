package models

type Profile struct {
	ID            int      `json:"id"`
	UUID          string   `json:"uuid"`
	Username      string   `json:"username"`
	Enable        int      `json:"enable"`
	Flow          string   `json:"flow"`
	LimitGB       float64  `json:"limit_gb"`
	UploadBytes   float64  `json:"upload_bytes"`
	DownloadBytes float64  `json:"download_bytes"`
	ExpireDays    int      `json:"expire_days"`
	ExpiresAt     string   `json:"expires_at"`
	SubUUID       string   `json:"sub_uuid"`
	InboundTags   []string `json:"inbound_tags"`
	ServerAddr    string   `json:"server_address"`
	Remark        string   `json:"remark"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

type Inbound struct {
	Tag      string `json:"tag"`
	Port     int    `json:"port"`
	Listen   string `json:"listen"`
	Protocol string `json:"protocol"`
}

type SubscriptionResponse struct {
	ProfileTitle string            `json:"profile_title"`
	Links        []string          `json:"links"`
	URLs         map[string]string `json:"urls"`
}

type ToggleResponse struct {
	Status string `json:"status"`
	Enable int    `json:"enable"`
}

type AnalyticsPeriod struct {
	Bytes     uint64 `json:"bytes"`
	Available bool   `json:"available"`
}

type ProfileAnalytics struct {
	UserID            int    `json:"user_id"`
	Username          string `json:"username"`
	CurrentTotalBytes uint64 `json:"current_total_bytes"`
	Periods           struct {
		Day   AnalyticsPeriod `json:"day"`
		Week  AnalyticsPeriod `json:"week"`
		Month AnalyticsPeriod `json:"month"`
		Year  AnalyticsPeriod `json:"year"`
	} `json:"periods"`
}

type ServerAnalytics struct {
	TotalTrafficBytes uint64 `json:"total_traffic_bytes"`
	UsersCount        int    `json:"users_count"`
	SamplesCount      int    `json:"samples_count"`
}

type AnalyticsResponse struct {
	Server ServerAnalytics `json:"server"`
}

type ProfileAnalyticsResponse struct {
	Profile ProfileAnalytics `json:"profile"`
	Server  ServerAnalytics  `json:"server"`
}
