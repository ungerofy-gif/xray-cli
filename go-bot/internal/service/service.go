package service

import (
	"context"
	"fmt"
	"html"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/example/xray-cli-ts/go-bot/internal/api"
	"github.com/example/xray-cli-ts/go-bot/internal/models"
	"github.com/example/xray-cli-ts/go-bot/internal/state"
)

type Service struct {
	api *api.Client
}

func New(apiClient *api.Client) *Service {
	return &Service{api: apiClient}
}

func (s *Service) ListProfiles(ctx context.Context) ([]models.Profile, error) {
	profiles, err := s.api.ListProfiles(ctx)
	if err != nil {
		return nil, err
	}
	sort.Slice(profiles, func(i, j int) bool {
		return strings.ToLower(profiles[i].Username) < strings.ToLower(profiles[j].Username)
	})
	return profiles, nil
}

func PaginateProfiles(profiles []models.Profile, page, pageSize int) ([]models.Profile, int, int) {
	if pageSize < 1 {
		pageSize = 8
	}
	totalPages := int(math.Ceil(float64(len(profiles)) / float64(pageSize)))
	if totalPages == 0 {
		totalPages = 1
	}
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if start > len(profiles) {
		start = len(profiles)
	}
	if end > len(profiles) {
		end = len(profiles)
	}
	return profiles[start:end], page, totalPages
}

func (s *Service) GetUserDetails(ctx context.Context, id int) (string, error) {
	profile, err := s.api.GetProfile(ctx, id)
	if err != nil {
		return "", err
	}
	sub, err := s.api.GetSubscription(ctx, id)
	if err != nil {
		return "", err
	}
	status := "Выключен"
	if profile.Enable == 1 {
		status = "Включен"
	}

	currentUsageBytes := uint64(0)
	if profile.UploadBytes+profile.DownloadBytes > 0 {
		currentUsageBytes = uint64(profile.UploadBytes + profile.DownloadBytes)
	}
	usageGB := float64(currentUsageBytes) / 1024 / 1024 / 1024
	expires := "Никогда"
	if profile.ExpireDays > 0 && profile.ExpiresAt != "" {
		if t, err := time.Parse(time.RFC3339, profile.ExpiresAt); err == nil {
			expires = t.Local().Format("2006-01-02")
		}
	}

	var b strings.Builder
	b.WriteString("👤 <b>Пользователь</b>\n")
	b.WriteString(fmt.Sprintf("Имя пользователя: <b>%s</b>\n", html.EscapeString(profile.Username)))
	b.WriteString(fmt.Sprintf("Статус: <b>%s</b>\n\n", status))
	b.WriteString("📊 <b>Трафик</b>\n")
	b.WriteString(fmt.Sprintf("Лимит по трафику: <b>%.2f GB</b>\n", profile.LimitGB))
	b.WriteString(fmt.Sprintf("Использовано трафика: <b>%.2f GB</b>\n", usageGB))
	b.WriteString(fmt.Sprintf("Истекает: <b>%s</b>\n", html.EscapeString(expires)))
	analyticsData, analyticsErr := s.api.GetProfileAnalytics(ctx, id)
	b.WriteString("\n🗂 <b>Аналитика пользователя</b>\n")
	if analyticsErr != nil {
		b.WriteString("1 день: недостаточно данных\n")
		b.WriteString("1 неделя: недостаточно данных\n")
		b.WriteString("1 месяц: недостаточно данных\n")
		b.WriteString("1 год: недостаточно данных\n")
	} else {
		b.WriteString("1 день: " + formatPeriod(analyticsData.Profile.Periods.Day.Bytes, analyticsData.Profile.Periods.Day.Available) + "\n")
		b.WriteString("1 неделя: " + formatPeriod(analyticsData.Profile.Periods.Week.Bytes, analyticsData.Profile.Periods.Week.Available) + "\n")
		b.WriteString("1 месяц: " + formatPeriod(analyticsData.Profile.Periods.Month.Bytes, analyticsData.Profile.Periods.Month.Available) + "\n")
		b.WriteString("1 год: " + formatPeriod(analyticsData.Profile.Periods.Year.Bytes, analyticsData.Profile.Periods.Year.Available) + "\n")
	}
	b.WriteString("\n🔗 <b>Подписки</b>\n")

	keys := make([]string, 0, len(sub.URLs))
	for k := range sub.URLs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		b.WriteString(fmt.Sprintf("• %s\n<code>%s</code>\n", html.EscapeString(humanClientName(key)), html.EscapeString(sub.URLs[key])))
	}

	return b.String(), nil
}

func formatPeriod(bytes uint64, available bool) string {
	if !available {
		return "недостаточно данных"
	}
	return "<b>" + formatBytesGiB(bytes) + "</b>"
}

func humanClientName(key string) string {
	switch key {
	case "default":
		return "default"
	case "v2rayn":
		return "v2rayn"
	case "clash":
		return "clash"
	case "mihomo":
		return "mihomo"
	case "clash_meta":
		return "clash-meta"
	default:
		return key
	}
}

func (s *Service) ToggleUser(ctx context.Context, id int) error {
	_, err := s.api.ToggleProfile(ctx, id)
	return err
}

func (s *Service) DeleteUser(ctx context.Context, id int) error {
	return s.api.DeleteProfile(ctx, id)
}

func (s *Service) GetInbounds(ctx context.Context) ([]models.Inbound, error) {
	return s.api.GetInbounds(ctx)
}

func (s *Service) StartEditInbounds(ctx context.Context, id int, username string) (state.EditInboundsSession, []models.Inbound, error) {
	tags, err := s.api.GetProfileInbounds(ctx, id)
	if err != nil {
		return state.EditInboundsSession{}, nil, err
	}
	inbounds, err := s.api.GetInbounds(ctx)
	if err != nil {
		return state.EditInboundsSession{}, nil, err
	}
	orig := make(map[string]bool, len(inbounds))
	for _, t := range tags {
		orig[t] = true
	}
	work := make(map[string]bool, len(orig))
	for k, v := range orig {
		work[k] = v
	}
	return state.EditInboundsSession{
		UserID:   id,
		Username: username,
		Original: orig,
		Working:  work,
	}, inbounds, nil
}

func ToggleInbound(session state.EditInboundsSession, tag string) state.EditInboundsSession {
	if session.Working == nil {
		session.Working = map[string]bool{}
	}
	session.Working[tag] = !session.Working[tag]
	return session
}

func (s *Service) ApplyEditInbounds(ctx context.Context, session state.EditInboundsSession) error {
	for tag := range session.Working {
		orig := session.Original[tag]
		now := session.Working[tag]
		if orig == now {
			continue
		}
		if now {
			if err := s.api.AddProfileInbound(ctx, session.UserID, tag); err != nil {
				return err
			}
			continue
		}
		if err := s.api.DeleteProfileInbound(ctx, session.UserID, tag); err != nil {
			return err
		}
	}
	return nil
}

func BuildEditTitle(username string) string {
	return fmt.Sprintf("✏️ <b>Изменение пользователя</b> <code>%s</code>", html.EscapeString(username))
}

func (s *Service) CreateUser(ctx context.Context, c state.AddUserConversation) (*models.Profile, error) {
	req := api.CreateProfileRequest{
		Username:       c.Username,
		LimitGB:        c.LimitGB,
		ExpireDays:     c.ExpireDays,
		AddAllInbounds: c.AddAll,
	}
	return s.api.CreateProfile(ctx, req)
}

func (s *Service) ReloadXray(ctx context.Context) error {
	return s.api.Reload(ctx)
}

func (s *Service) GetServerAnalytics(ctx context.Context) (*models.ServerAnalytics, error) {
	out, err := s.api.GetAnalytics(ctx)
	if err != nil {
		return nil, err
	}
	return &out.Server, nil
}

func formatBytesGiB(bytes uint64) string {
	gb := float64(bytes) / 1024 / 1024 / 1024
	return fmt.Sprintf("%.2f GB", gb)
}

func ParsePositiveFloat(raw string) (float64, error) {
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, fmt.Errorf("negative value")
	}
	return v, nil
}

func ParseNonNegativeInt(raw string) (int, error) {
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, err
	}
	if v < 0 {
		return 0, fmt.Errorf("negative value")
	}
	return v, nil
}
