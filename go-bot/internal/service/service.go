package service

import (
	"context"
	"fmt"
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

	usageGB := (profile.UploadBytes + profile.DownloadBytes) / 1024 / 1024 / 1024
	expires := "Никогда"
	if profile.ExpireDays > 0 && profile.ExpiresAt != "" {
		if t, err := time.Parse(time.RFC3339, profile.ExpiresAt); err == nil {
			expires = t.Local().Format("2006-01-02")
		}
	}

	var b strings.Builder
	b.WriteString(fmt.Sprintf("Имя пользователя: %s\n", profile.Username))
	b.WriteString(fmt.Sprintf("Статус: %s\n\n", status))
	b.WriteString(fmt.Sprintf("Лимит по трафику: `%.2f GB`\n", profile.LimitGB))
	b.WriteString(fmt.Sprintf("Использовано трафика: `%.2f GB`\n", usageGB))
	b.WriteString(fmt.Sprintf("Истекает: `%s`\n\n", expires))
	b.WriteString("Подписки:\n")

	keys := make([]string, 0, len(sub.URLs))
	for k := range sub.URLs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		b.WriteString(fmt.Sprintf("%s\n`%s`\n", humanClientName(key), sub.URLs[key]))
	}

	return b.String(), nil
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
	return fmt.Sprintf("Изменение пользователя `%s`", username)
}

func (s *Service) CreateUser(ctx context.Context, c state.AddUserConversation) (*models.Profile, error) {
	req := api.CreateProfileRequest{
		Username:       c.Username,
		LimitGB:        c.LimitGB,
		ExpireDays:     c.ExpireDays,
		ServerAddress:  c.ServerAddr,
		Remark:         c.Remark,
		AddAllInbounds: c.AddAll,
	}
	return s.api.CreateProfile(ctx, req)
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
