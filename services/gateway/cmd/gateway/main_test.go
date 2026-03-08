package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"trapchat/pkgs/protocol"
)

func TestHandleRoomsRequiresGet(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	req := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
	w := httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestHandleRoomsReturnsEmptyList(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	req := httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	w := httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	rooms, ok := body["rooms"].([]interface{})
	if !ok {
		t.Fatal("expected rooms array")
	}
	if len(rooms) != 0 {
		t.Errorf("expected 0 rooms, got %d", len(rooms))
	}
}

func TestHandleRoomsWithData(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	srv.store.Join("test-room", "peer1")
	srv.store.Join("test-room", "peer2")

	req := httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	w := httptest.NewRecorder()
	srv.handleRooms(w, req)

	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	count := body["count"].(float64)
	if count != 1 {
		t.Errorf("expected 1 room, got %v", count)
	}
}

func TestHandleRoomInfo(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	srv.store.Join("myroom", "peer1")

	req := httptest.NewRequest(http.MethodGet, "/api/rooms/myroom/info", nil)
	w := httptest.NewRecorder()
	srv.handleRoomSub(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	if body["exists"] != true {
		t.Error("expected exists=true")
	}
	if body["peers"].(float64) != 1 {
		t.Errorf("expected 1 peer, got %v", body["peers"])
	}
}

func TestHandleRoomCleanup(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	srv.store.Join("stale-room", "peer1")

	req := httptest.NewRequest(http.MethodPost, "/api/rooms/stale-room/cleanup", nil)
	w := httptest.NewRecorder()
	srv.handleRoomSub(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	json.NewDecoder(w.Body).Decode(&body)
	if body["room"] != "stale-room" {
		t.Errorf("expected room=stale-room, got %v", body["room"])
	}
}

func TestAuthEnforcement(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	srv.authToken = "secret-token"

	// No auth header
	req := httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	w := httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 without auth, got %d", w.Code)
	}

	// Wrong token
	req = httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	w = httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong token, got %d", w.Code)
	}

	// Correct token via header
	req = httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	w = httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with correct token header, got %d", w.Code)
	}

	// Correct token via query param (WebSocket browser auth)
	req = httptest.NewRequest(http.MethodGet, "/api/rooms?token=secret-token", nil)
	w = httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 with correct token query param, got %d", w.Code)
	}

	// Wrong token via query param
	req = httptest.NewRequest(http.MethodGet, "/api/rooms?token=wrong", nil)
	w = httptest.NewRecorder()
	srv.handleRooms(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 with wrong token query param, got %d", w.Code)
	}
}

func TestSubmitJobSendsCorrectPost(t *testing.T) {
	var receivedBody map[string]interface{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/jobs" {
			t.Errorf("expected /jobs, got %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &receivedBody)
		w.WriteHeader(http.StatusCreated)
	}))
	defer ts.Close()

	srv := NewServer()
	defer srv.stop()
	srv.workerURL = ts.URL

	err := srv.submitJob("room:cleanup", map[string]interface{}{
		"gatewayURL": "http://localhost:8080",
	})
	if err != nil {
		t.Fatalf("submitJob failed: %v", err)
	}
	if receivedBody["type"] != "room:cleanup" {
		t.Errorf("expected type=room:cleanup, got %v", receivedBody["type"])
	}
}

func TestSignEnvelopeProducesSignature(t *testing.T) {
	srv := NewServer()
	defer srv.stop()
	env := &Envelope{
		ID:        "peer1",
		Type:      "chat",
		Room:      "room1",
		Payload:   "hello",
		Timestamp: 1234567890,
	}
	srv.signEnvelope(env)
	if env.Sig == "" {
		t.Error("signEnvelope should produce a non-empty signature")
	}
}

func TestValidateRoomName(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		wantOK bool
	}{
		{"valid simple", "my-room", true},
		{"valid unicode", "café-日本語", true},
		{"valid with dots", "room.name.123", true},
		{"empty", "", false},
		{"too long", strings.Repeat("a", 65), false},
		{"max length", strings.Repeat("a", 64), true},
		{"has space", "my room", true},
		{"has newline", "room\nname", false},
		{"has tab", "room\tname", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := validateRoomName(tt.input)
			if tt.wantOK && result != "" {
				t.Errorf("expected valid, got error: %s", result)
			}
			if !tt.wantOK && result == "" {
				t.Error("expected error, got valid")
			}
		})
	}
}

func TestSanitizeNickname(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"normal", "Alice", "Alice"},
		{"empty", "", ""},
		{"control chars stripped", "Al\x00ic\x1Fe", "Alice"},
		{"DEL stripped", "Bob\x7F", "Bob"},
		{"truncated at 32", "abcdefghijklmnopqrstuvwxyz1234567890", "abcdefghijklmnopqrstuvwxyz123456"},
		{"whitespace trimmed", "  Alice  ", "Alice"},
		{"only control chars", "\x00\x01\x02", ""},
		{"unicode preserved", "名前テスト", "名前テスト"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeNickname(tt.input)
			if got != tt.want {
				t.Errorf("sanitizeNickname(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

// Envelope alias for test readability
type Envelope = protocol.Envelope
