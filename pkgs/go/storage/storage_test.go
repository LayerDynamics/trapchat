package storage

import (
	"sync"
	"testing"
	"time"
)

func TestJoinCreatesRoom(t *testing.T) {
	s := NewStore()
	count := s.Join("room1", "peer1")
	if count != 1 {
		t.Fatalf("expected 1 peer, got %d", count)
	}
	if got := s.Count("room1"); got != 1 {
		t.Fatalf("Count expected 1, got %d", got)
	}
}

func TestJoinMultiplePeers(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	count := s.Join("room1", "peer2")
	if count != 2 {
		t.Fatalf("expected 2 peers, got %d", count)
	}
}

func TestJoinIdempotent(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	count := s.Join("room1", "peer1")
	if count != 1 {
		t.Fatalf("duplicate join should not increase count, got %d", count)
	}
}

func TestLeaveRemovesPeer(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.Join("room1", "peer2")
	remaining := s.Leave("room1", "peer1")
	if remaining != 1 {
		t.Fatalf("expected 1 remaining, got %d", remaining)
	}
}

func TestLeaveDeletesEmptyRoom(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.Leave("room1", "peer1")

	rooms := s.Rooms()
	for _, name := range rooms {
		if name == "room1" {
			t.Fatal("empty room should be deleted")
		}
	}
}

func TestLeaveNonexistentRoom(t *testing.T) {
	s := NewStore()
	count := s.Leave("nope", "peer1")
	if count != 0 {
		t.Fatalf("expected 0, got %d", count)
	}
}

func TestPeers(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.Join("room1", "peer2")
	peers := s.Peers("room1")
	if len(peers) != 2 {
		t.Fatalf("expected 2 peers, got %d", len(peers))
	}
}

func TestPeersEmptyRoom(t *testing.T) {
	s := NewStore()
	peers := s.Peers("nope")
	if peers != nil {
		t.Fatalf("expected nil, got %v", peers)
	}
}

func TestRooms(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.Join("room2", "peer2")
	rooms := s.Rooms()
	if len(rooms) != 2 {
		t.Fatalf("expected 2 rooms, got %d", len(rooms))
	}
}

func TestStaleRooms(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	// Manually backdate activity
	s.mu.Lock()
	s.rooms["room1"].LastActivity = time.Now().Add(-2 * time.Hour)
	s.mu.Unlock()

	stale := s.StaleRooms(1 * time.Hour)
	if len(stale) != 1 || stale[0] != "room1" {
		t.Fatalf("expected room1 as stale, got %v", stale)
	}

	fresh := s.StaleRooms(3 * time.Hour)
	if len(fresh) != 0 {
		t.Fatalf("expected no stale rooms, got %v", fresh)
	}
}

func TestRoomInfo(t *testing.T) {
	s := NewStore()
	_, _, exists := s.RoomInfo("nope")
	if exists {
		t.Fatal("expected not exists")
	}

	s.Join("room1", "peer1")
	peers, lastActivity, exists := s.RoomInfo("room1")
	if !exists || peers != 1 || lastActivity.IsZero() {
		t.Fatalf("unexpected RoomInfo: peers=%d, lastActivity=%v, exists=%v", peers, lastActivity, exists)
	}
}

func TestJoinLeaveUpdateLastActivity(t *testing.T) {
	s := NewStore()
	before := time.Now()
	s.Join("room1", "peer1")
	_, la, exists := s.RoomInfo("room1")
	if !exists {
		t.Fatal("room should exist after join")
	}
	if la.Before(before) {
		t.Error("LastActivity should be updated on join")
	}

	time.Sleep(10 * time.Millisecond)
	beforeLeave := time.Now()
	s.Join("room1", "peer2") // add second peer so room isn't deleted on leave
	s.Leave("room1", "peer1")
	_, la2, _ := s.RoomInfo("room1")
	if la2.Before(beforeLeave) {
		t.Error("LastActivity should be updated on leave")
	}
}

func TestRoomsWithCountsAtomicSnapshot(t *testing.T) {
	s := NewStore()
	s.Join("a", "p1")
	s.Join("a", "p2")
	s.Join("b", "p3")

	snaps := s.RoomsWithCounts()
	if len(snaps) != 2 {
		t.Fatalf("expected 2 rooms, got %d", len(snaps))
	}
	counts := make(map[string]int)
	for _, snap := range snaps {
		counts[snap.Name] = snap.Count
	}
	if counts["a"] != 2 {
		t.Errorf("room a: expected 2, got %d", counts["a"])
	}
	if counts["b"] != 1 {
		t.Errorf("room b: expected 1, got %d", counts["b"])
	}
}

func TestSetNickname(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.SetNickname("room1", "peer1", "alice")
	nicks := s.PeersWithNicknames("room1")
	if nicks["peer1"] != "alice" {
		t.Fatalf("expected nickname 'alice', got %q", nicks["peer1"])
	}
}

func TestPeersWithNicknames(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.Join("room1", "peer2")
	s.SetNickname("room1", "peer1", "alice")
	nicks := s.PeersWithNicknames("room1")
	if len(nicks) != 2 {
		t.Fatalf("expected 2 peers, got %d", len(nicks))
	}
	if nicks["peer1"] != "alice" {
		t.Fatalf("expected 'alice', got %q", nicks["peer1"])
	}
	if nicks["peer2"] != "" {
		t.Fatalf("expected empty nickname, got %q", nicks["peer2"])
	}
}

func TestPeersWithNicknamesNonexistent(t *testing.T) {
	s := NewStore()
	nicks := s.PeersWithNicknames("nope")
	if nicks != nil {
		t.Fatalf("expected nil, got %v", nicks)
	}
}

func TestSetNicknameNonexistentRoom(t *testing.T) {
	s := NewStore()
	// Should not panic
	s.SetNickname("nope", "peer1", "alice")
}

func TestSetRoomTTL(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.SetRoomTTL("room1", 3600)
	ttl, createdAt, exists := s.RoomTTL("room1")
	if !exists || ttl != 3600 {
		t.Fatalf("expected TTL 3600, got %d, exists=%v", ttl, exists)
	}
	if createdAt.IsZero() {
		t.Fatal("expected non-zero CreatedAt")
	}
}

func TestRoomTTLNonexistent(t *testing.T) {
	s := NewStore()
	_, _, exists := s.RoomTTL("nope")
	if exists {
		t.Fatal("expected not exists")
	}
}

func TestExpiredRooms(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.SetRoomTTL("room1", 1) // 1 second TTL
	// Backdate creation
	s.mu.Lock()
	s.rooms["room1"].CreatedAt = time.Now().Add(-2 * time.Second)
	s.mu.Unlock()

	expired := s.ExpiredRooms()
	if len(expired) != 1 || expired[0] != "room1" {
		t.Fatalf("expected room1 expired, got %v", expired)
	}
}

func TestExpiredRoomsNoTTL(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	// No TTL set (0) — should not expire
	expired := s.ExpiredRooms()
	if len(expired) != 0 {
		t.Fatalf("expected no expired rooms, got %v", expired)
	}
}

func TestExpiredRoomsNotYetExpired(t *testing.T) {
	s := NewStore()
	s.Join("room1", "peer1")
	s.SetRoomTTL("room1", 86400) // 24 hours
	expired := s.ExpiredRooms()
	if len(expired) != 0 {
		t.Fatalf("expected no expired rooms, got %v", expired)
	}
}

func TestJoinSetsCreatedAt(t *testing.T) {
	s := NewStore()
	before := time.Now()
	s.Join("room1", "peer1")
	_, createdAt, exists := s.RoomTTL("room1")
	if !exists {
		t.Fatal("room should exist")
	}
	if createdAt.Before(before) {
		t.Error("CreatedAt should be >= before")
	}
}

func TestSetRoomTTLNonexistentRoom(t *testing.T) {
	s := NewStore()
	// Should not panic and should be a no-op
	s.SetRoomTTL("nonexistent", 3600)
	_, _, exists := s.RoomTTL("nonexistent")
	if exists {
		t.Fatal("SetRoomTTL on nonexistent room should not create the room")
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := NewStore()
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			room := "room1"
			peer := "peer" + string(rune('A'+id%26))
			s.Join(room, peer)
			s.Count(room)
			s.Peers(room)
			s.Leave(room, peer)
		}(i)
	}
	wg.Wait()
}
