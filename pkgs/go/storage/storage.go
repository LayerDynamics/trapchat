package storage

import "sync"

// Room tracks connected peers for one chat room.
type Room struct {
	Name  string
	Peers map[string]bool
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
		r = &Room{Name: room, Peers: make(map[string]bool)}
		s.rooms[room] = r
	}
	r.Peers[peerID] = true
	return len(r.Peers)
}

// Leave removes a peer from a room. Returns remaining count.
// Cleans up empty rooms.
func (s *Store) Leave(room, peerID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	r, ok := s.rooms[room]
	if !ok {
		return 0
	}
	delete(r.Peers, peerID)
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
