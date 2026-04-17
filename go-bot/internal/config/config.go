package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	TelegramToken  string
	AllowedUserIDs map[int64]struct{}
	APIBaseURL     string
	APIKey         string
	RequestTimeout time.Duration
	MetricsTimeout time.Duration
	CommandTimeout time.Duration
	UsersPerPage   int
	SystemEnvFile  string
	AnalyticsPath  string
	AnalyticsStep  time.Duration
}

func Load() (Config, error) {
	systemEnvFile := getenvDefault("SYSTEM_ENV_FILE", "/etc/default/xraycli-api")
	loadDotEnvFileIfExists(systemEnvFile)

	host := getenvDefault("API_HOST", "127.0.0.1")
	port := getenvDefault("API_PORT", "2053")
	baseURL := getenvDefault("API_BASE_URL", fmt.Sprintf("http://%s:%s", host, port))

	allowed, err := parseAllowedUsers(os.Getenv("TG_ALLOWED_USER_IDS"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TG_ALLOWED_USER_IDS: %w", err)
	}
	if len(allowed) == 0 {
		return Config{}, errors.New("TG_ALLOWED_USER_IDS is required")
	}

	tgToken := strings.TrimSpace(os.Getenv("TG_BOT_TOKEN"))
	if tgToken == "" {
		return Config{}, errors.New("TG_BOT_TOKEN is required")
	}

	requestTimeout := parseDurationDefault("API_TIMEOUT", 10*time.Second)
	metricsTimeout := parseDurationDefault("METRICS_TIMEOUT", 3*time.Second)
	commandTimeout := parseDurationDefault("COMMAND_TIMEOUT", 15*time.Second)
	usersPerPage := parseIntDefault("USERS_PER_PAGE", 8)
	if usersPerPage < 1 {
		usersPerPage = 8
	}

	return Config{
		TelegramToken:  tgToken,
		AllowedUserIDs: allowed,
		APIBaseURL:     strings.TrimRight(baseURL, "/"),
		APIKey:         strings.TrimSpace(os.Getenv("API_KEY")),
		RequestTimeout: requestTimeout,
		MetricsTimeout: metricsTimeout,
		CommandTimeout: commandTimeout,
		UsersPerPage:   usersPerPage,
		SystemEnvFile:  systemEnvFile,
		AnalyticsPath:  getenvDefault("BOT_ANALYTICS_PATH", "/usr/local/xray-cli/go-bot/data/traffic-analytics.json"),
		AnalyticsStep:  parseDurationDefault("BOT_ANALYTICS_STEP", 15*time.Minute),
	}, nil
}

func loadDotEnvFileIfExists(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		k := strings.TrimSpace(parts[0])
		v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		if k == "" {
			continue
		}
		if _, exists := os.LookupEnv(k); !exists {
			_ = os.Setenv(k, v)
		}
	}
}

func parseAllowedUsers(raw string) (map[int64]struct{}, error) {
	out := make(map[int64]struct{})
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return out, nil
	}
	for _, token := range strings.Split(raw, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		v, err := strconv.ParseInt(token, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("bad user id %q", token)
		}
		out[v] = struct{}{}
	}
	return out, nil
}

func parseDurationDefault(key string, def time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	v, err := time.ParseDuration(raw)
	if err != nil {
		return def
	}
	return v
}

func parseIntDefault(key string, def int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return v
}

func getenvDefault(k, def string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	return v
}
