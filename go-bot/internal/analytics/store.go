package analytics

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/example/xray-cli-ts/go-bot/internal/models"
)

type Snapshot struct {
	At    time.Time         `json:"at"`
	Users map[string]uint64 `json:"users"`
}

type payload struct {
	Version int        `json:"version"`
	Samples []Snapshot `json:"samples"`
}

type PeriodUsage struct {
	Day struct {
		Bytes     uint64
		Available bool
	}
	Week struct {
		Bytes     uint64
		Available bool
	}
	Month struct {
		Bytes     uint64
		Available bool
	}
	Year struct {
		Bytes     uint64
		Available bool
	}
}

type Store struct {
	mu       sync.RWMutex
	path     string
	step     time.Duration
	maxItems int
	samples  []Snapshot
	log      *slog.Logger
}

func NewStore(path string, step time.Duration, logger *slog.Logger) *Store {
	if step <= 0 {
		step = 15 * time.Minute
	}
	s := &Store{
		path:     path,
		step:     step,
		maxItems: 24 * 400, // ~400 days with hourly-like snapshots
		log:      logger,
	}
	s.load()
	return s
}

func (s *Store) RecordProfiles(profiles []models.Profile) {
	if len(profiles) == 0 {
		return
	}
	now := time.Now().UTC()
	users := make(map[string]uint64, len(profiles))
	for _, p := range profiles {
		total := p.UploadBytes + p.DownloadBytes
		if total < 0 {
			total = 0
		}
		users[strconv.Itoa(p.ID)] = uint64(total)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.samples) > 0 && now.Sub(s.samples[len(s.samples)-1].At) < s.step {
		s.samples[len(s.samples)-1] = Snapshot{At: now, Users: users}
	} else {
		s.samples = append(s.samples, Snapshot{At: now, Users: users})
	}
	if len(s.samples) > s.maxItems {
		s.samples = s.samples[len(s.samples)-s.maxItems:]
	}
	s.saveLocked()
}

func (s *Store) GetPeriodUsage(userID int, currentTotal uint64, now time.Time) PeriodUsage {
	s.mu.RLock()
	samples := append([]Snapshot(nil), s.samples...)
	s.mu.RUnlock()

	return PeriodUsage{
		Day:   calcPeriod(samples, userID, currentTotal, now.Add(-24*time.Hour)),
		Week:  calcPeriod(samples, userID, currentTotal, now.Add(-7*24*time.Hour)),
		Month: calcPeriod(samples, userID, currentTotal, now.Add(-30*24*time.Hour)),
		Year:  calcPeriod(samples, userID, currentTotal, now.Add(-365*24*time.Hour)),
	}
}

func calcPeriod(samples []Snapshot, userID int, currentTotal uint64, cutoff time.Time) struct {
	Bytes     uint64
	Available bool
} {
	out := struct {
		Bytes     uint64
		Available bool
	}{}
	key := strconv.Itoa(userID)

	for i := len(samples) - 1; i >= 0; i-- {
		snap := samples[i]
		if snap.At.After(cutoff) {
			continue
		}
		past, ok := snap.Users[key]
		if !ok {
			out.Available = false
			return out
		}
		out.Available = true
		if currentTotal > past {
			out.Bytes = currentTotal - past
		}
		return out
	}
	return out
}

func (s *Store) load() {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var p payload
	if err := json.Unmarshal(raw, &p); err != nil {
		if s.log != nil {
			s.log.Warn("failed to parse analytics file", "error", err)
		}
		return
	}
	s.samples = p.Samples
}

func (s *Store) saveLocked() {
	if s.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		if s.log != nil {
			s.log.Warn("failed to create analytics directory", "error", err)
		}
		return
	}
	data, err := json.MarshalIndent(payload{Version: 1, Samples: s.samples}, "", "  ")
	if err != nil {
		if s.log != nil {
			s.log.Warn("failed to encode analytics data", "error", err)
		}
		return
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		if s.log != nil {
			s.log.Warn("failed to write analytics tmp file", "error", err)
		}
		return
	}
	if err := os.Rename(tmp, s.path); err != nil {
		if s.log != nil {
			s.log.Warn("failed to replace analytics file", "error", err)
		}
	}
}

func FormatBytesGiB(bytes uint64) string {
	gb := float64(bytes) / 1024 / 1024 / 1024
	return fmt.Sprintf("%.2f GB", gb)
}
