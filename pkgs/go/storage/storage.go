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
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.rooms[room]
	if !ok {
		r = &Room{Name: room, Peers: make(map[string]string)}
		s.rooms[room] = r
	}
	if _, exists := r.Peers[peerID]; !exists {
		r.Peers[peerID] = ""
	}
	r.LastActivity = time.Now()
	return len(r.Peers)
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
