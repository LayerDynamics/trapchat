package storage

import (
	"sync"
	"time"
)

// Room tracks connected peers for one chat room.
type Room struct {
	Name         string
	Peers        map[string]string // peerID → nickname (empty string if no nickname)
	LastActivity time.Time
	TTLSeconds   int64
	CreatedAt    time.Time
	Salt         []byte
}

// Store is a thread-safe in-memory room registry.
type Store struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

// NewStore creates an empty store.
func NewStore() *Store {
	return &Store{rooms: make(map[string]*Room)}
}

// Join adds a peer to a room, creating the room if needed. Returns peer count.
func (s *Store) Join(room, peerID string) int {
	count, _ := s.JoinWithTTL(room, peerID, 0, nil)
	return count
}

// JoinWithTTL atomically joins a room (creating it if needed) and sets TTL on new rooms.
// Returns (peerCount, isNewRoom). TTL is only applied when ttlSeconds > 0 and room is new.
// Salt is stored only on new room creation (first-writer-wins); subsequent joins ignore salt.
func (s *Store) JoinWithTTL(room, peerID string, ttlSeconds int64, salt []byte) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.rooms[room]
	isNew := !ok
	if isNew {
		r = &Room{Name: room, Peers: make(map[string]string), CreatedAt: time.Now()}
		if ttlSeconds > 0 {
			r.TTLSeconds = ttlSeconds
		}
		if len(salt) > 0 {
			r.Salt = make([]byte, len(salt))
			copy(r.Salt, salt)
		}
		s.rooms[room] = r
	}
	if _, exists := r.Peers[peerID]; !exists {
		r.Peers[peerID] = ""
	}
	r.LastActivity = time.Now()
	return len(r.Peers), isNew
}

// RoomSalt returns the salt for a room, or nil if none is set or room doesn't exist.
func (s *Store) RoomSalt(room string) []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.rooms[room]
	if !ok || len(r.Salt) == 0 {
		return nil
	}
	dst := make([]byte, len(r.Salt))
	copy(dst, r.Salt)
	return dst
}

// Leave removes a peer from a room. Returns remaining count.
// Deletes the room immediately when empty.
func (s *Store) Leave(room, peerID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.rooms[room]
	if !ok {
		return 0
	}
	delete(r.Peers, peerID)
	r.LastActivity = time.Now()
	count := len(r.Peers)
	if count == 0 {
		delete(s.rooms, room)
	}
	return count
}

// Count returns the number of peers in a room.
func (s *Store) Count(room string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if r, ok := s.rooms[room]; ok {
		return len(r.Peers)
	}
	return 0
}

// Peers returns the list of peer IDs in a room.
func (s *Store) Peers(room string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.rooms[room]
	if !ok {
		return nil
	}
	peers := make([]string, 0, len(r.Peers))
	for id := range r.Peers {
		peers = append(peers, id)
	}
	return peers
}

// SetNickname sets a nickname for a peer in a room.
func (s *Store) SetNickname(room, peerID, nickname string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.rooms[room]
	if !ok {
		return
	}
	if _, exists := r.Peers[peerID]; exists {
		r.Peers[peerID] = nickname
	}
}

// PeersWithNicknames returns a map of peerID→nickname for a room.
func (s *Store) PeersWithNicknames(room string) map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.rooms[room]
	if !ok {
		return nil
	}
	result := make(map[string]string, len(r.Peers))
	for id, nick := range r.Peers {
		result[id] = nick
	}
	return result
}

// Rooms returns a list of active room names.
func (s *Store) Rooms() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.rooms))
	for name := range s.rooms {
		names = append(names, name)
	}
	return names
}

// RoomSnapshot holds a room name and its peer count at a single point in time.
type RoomSnapshot struct {
	Name  string
	Count int
}

// RoomsWithCounts returns all rooms with their peer counts in a single lock acquisition.
func (s *Store) RoomsWithCounts() []RoomSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]RoomSnapshot, 0, len(s.rooms))
	for name, r := range s.rooms {
		result = append(result, RoomSnapshot{Name: name, Count: len(r.Peers)})
	}
	return result
}

// StaleRooms returns room names with no activity beyond maxIdle.
func (s *Store) StaleRooms(maxIdle time.Duration) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	cutoff := time.Now().Add(-maxIdle)
	var stale []string
	for name, r := range s.rooms {
		if r.LastActivity.Before(cutoff) {
			stale = append(stale, name)
		}
	}
	return stale
}

// RoomCount returns the total number of active rooms.
func (s *Store) RoomCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.rooms)
}

// RoomInfo returns peer count, last activity, and existence for a room.
func (s *Store) RoomInfo(name string) (peers int, lastActivity time.Time, exists bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.rooms[name]
	if !ok {
		return 0, time.Time{}, false
	}
	return len(r.Peers), r.LastActivity, true
}

// SetRoomTTL sets the TTL in seconds for a room.
func (s *Store) SetRoomTTL(room string, ttlSeconds int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if r, ok := s.rooms[room]; ok {
		r.TTLSeconds = ttlSeconds
	}
}

// RoomTTL returns TTL seconds, creation time, and existence for a room.
func (s *Store) RoomTTL(room string) (ttlSeconds int64, createdAt time.Time, exists bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	r, ok := s.rooms[room]
	if !ok {
		return 0, time.Time{}, false
	}
	return r.TTLSeconds, r.CreatedAt, true
}

// ExpiredRooms returns room names where TTL > 0 and current time exceeds CreatedAt + TTL.
func (s *Store) ExpiredRooms() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now()
	var expired []string
	for name, r := range s.rooms {
		if r.TTLSeconds > 0 && now.After(r.CreatedAt.Add(time.Duration(r.TTLSeconds)*time.Second)) {
			expired = append(expired, name)
		}
	}
	return expired
}
