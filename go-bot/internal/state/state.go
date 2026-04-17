package state

import (
	"sync"
	"time"
)

type AddStep string

const (
	AddStepUsername    AddStep = "username"
	AddStepLimitGB     AddStep = "limit_gb"
	AddStepExpireDays  AddStep = "expire_days"
	AddStepAddInbounds AddStep = "add_all_inbounds"
)

type AddUserConversation struct {
	Step       AddStep
	Username   string
	LimitGB    float64
	ExpireDays int
	AddAll     bool
	StartedAt  time.Time
	UpdatedAt  time.Time
}

type EditInboundsSession struct {
	UserID    int
	Username  string
	Original  map[string]bool
	Working   map[string]bool
	UpdatedAt time.Time
}

type Store struct {
	mu            sync.RWMutex
	conversations map[int64]AddUserConversation
	edits         map[int64]EditInboundsSession
	ttl           time.Duration
}

func NewStore(ttl time.Duration) *Store {
	return &Store{
		conversations: make(map[int64]AddUserConversation),
		edits:         make(map[int64]EditInboundsSession),
		ttl:           ttl,
	}
}

func (s *Store) SetConversation(userID int64, c AddUserConversation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.UpdatedAt = time.Now()
	s.conversations[userID] = c
}

func (s *Store) GetConversation(userID int64) (AddUserConversation, bool) {
	s.mu.RLock()
	c, ok := s.conversations[userID]
	s.mu.RUnlock()
	if !ok {
		return AddUserConversation{}, false
	}
	if s.isExpired(c.UpdatedAt) {
		s.DeleteConversation(userID)
		return AddUserConversation{}, false
	}
	return c, true
}

func (s *Store) DeleteConversation(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conversations, userID)
}

func (s *Store) SetEdit(userID int64, e EditInboundsSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e.UpdatedAt = time.Now()
	s.edits[userID] = e
}

func (s *Store) GetEdit(userID int64) (EditInboundsSession, bool) {
	s.mu.RLock()
	e, ok := s.edits[userID]
	s.mu.RUnlock()
	if !ok {
		return EditInboundsSession{}, false
	}
	if s.isExpired(e.UpdatedAt) {
		s.DeleteEdit(userID)
		return EditInboundsSession{}, false
	}
	return e, true
}

func (s *Store) DeleteEdit(userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.edits, userID)
}

func (s *Store) isExpired(updatedAt time.Time) bool {
	if s.ttl <= 0 {
		return false
	}
	return time.Since(updatedAt) > s.ttl
}
