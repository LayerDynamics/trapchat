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
