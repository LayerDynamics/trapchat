package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	tccrypto "trapchat/pkgs/crypto"
	"trapchat/pkgs/protocol"
	"trapchat/pkgs/storage"
)

const (
	peerSendBufSize  = 64
	writeWaitTimeout = 10 * time.Second
)

// peer wraps a websocket connection with a buffered write queue.
// Messages are sent via the sendCh channel and drained by a dedicated goroutine,
// preventing a slow peer from blocking broadcasts to others.
type peer struct {
	conn   *websocket.Conn
	wmu    sync.Mutex
	sendCh chan []byte
	done   chan struct{}
}

func newPeer(conn *websocket.Conn) *peer {
	p := &peer{
		conn:   conn,
		sendCh: make(chan []byte, peerSendBufSize),
		done:   make(chan struct{}),
	}
	go p.writePump()
	return p
}

// writePump drains the send channel and writes to the WebSocket sequentially.
func (p *peer) writePump() {
	defer close(p.done)
	for msg := range p.sendCh {
		p.wmu.Lock()
		p.conn.SetWriteDeadline(time.Now().Add(writeWaitTimeout))
		err := p.conn.WriteMessage(websocket.TextMessage, msg)
		p.wmu.Unlock()
		if err != nil {
			return
		}
	}
}

// enqueue sends data to the write queue. Drops the message if the buffer is full.
func (p *peer) enqueue(data []byte) {
	select {
	case p.sendCh <- data:
	default:
		// Drop message for slow peer rather than blocking the broadcaster
	}
}

// writeControl writes a control message (ping) directly with the write mutex.
func (p *peer) writeControl(msgType int, data []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	p.conn.SetWriteDeadline(time.Now().Add(writeWaitTimeout))
	return p.conn.WriteMessage(msgType, data)
}

// closeSend closes the send channel and waits for the write pump to drain.
func (p *peer) closeSend() {
	close(p.sendCh)
	<-p.done
}

// rateLimiter tracks per-peer message rates using a token bucket.
type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*tokenBucket
	rate     int           // tokens per interval
	interval time.Duration // refill interval
	burst    int           // max tokens (burst capacity)
}

type tokenBucket struct {
	tokens   int
	lastFill time.Time
}

func newRateLimiter(rate int, interval time.Duration, burst int) *rateLimiter {
	return &rateLimiter{
		buckets:  make(map[string]*tokenBucket),
		rate:     rate,
		interval: interval,
		burst:    burst,
	}
}

// allow returns true if the peer is within rate limits.
func (rl *rateLimiter) allow(peerID string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[peerID]
	if !ok {
		b = &tokenBucket{tokens: rl.burst, lastFill: time.Now()}
		rl.buckets[peerID] = b
	}

	// Refill tokens based on elapsed time
	elapsed := time.Since(b.lastFill)
	refill := int(elapsed / rl.interval) * rl.rate
	if refill > 0 {
		b.tokens += refill
		if b.tokens > rl.burst {
			b.tokens = rl.burst
		}
		b.lastFill = time.Now()
	}

	if b.tokens <= 0 {
		return false
	}
	b.tokens--
	return true
}

func (rl *rateLimiter) remove(peerID string) {
	rl.mu.Lock()
	delete(rl.buckets, peerID)
	rl.mu.Unlock()
}

// Server holds all gateway state, enabling testability and avoiding package-level globals.
type Server struct {
	store    *storage.Store
	upgrader websocket.Upgrader
	connMu   sync.RWMutex
	conns    map[string]*peer
	peerRooms map[string]string

	relayURL  string
	relayConn *websocket.Conn
	relayMu   sync.Mutex

	rl        *rateLimiter
	authToken string // optional — set via AUTH_TOKEN env var
	serverKey []byte // AES-256-GCM key for server-side envelope signing

	workerURL    string // optional — set via WORKER_URL env var
	workerClient *http.Client
}

// allowedOrigins returns the set of permitted WebSocket origins from the
// ALLOWED_ORIGINS env var (comma-separated). An empty/unset var means all
// origins are allowed (development mode).
func allowedOrigins() map[string]bool {
	raw := os.Getenv("ALLOWED_ORIGINS")
	if raw == "" {
		return nil // allow all — dev mode
	}
	origins := make(map[string]bool)
	for _, o := range strings.Split(raw, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			origins[strings.ToLower(o)] = true
		}
	}
	return origins
}

func NewServer() *Server {
	origins := allowedOrigins()

	serverKey, err := tccrypto.GenerateKey()
	if err != nil {
		log.Fatalf("failed to generate server key: %v", err)
	}

	return &Server{
		store: storage.NewStore(),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				if origins == nil {
					return true // dev mode — no restriction
				}
				origin := r.Header.Get("Origin")
				if origin == "" {
					return false
				}
				u, err := url.Parse(origin)
				if err != nil {
					return false
				}
				return origins[strings.ToLower(u.Scheme+"://"+u.Host)]
			},
		},
		conns:     make(map[string]*peer),
		peerRooms: make(map[string]string),
		// 10 messages per second, burst of 20
		rl:        newRateLimiter(10, time.Second, 20),
		authToken: os.Getenv("AUTH_TOKEN"),
		serverKey: serverKey,
		workerURL:    os.Getenv("WORKER_URL"),
		workerClient: &http.Client{Timeout: 10 * time.Second},
	}
}

func main() {
	port := os.Getenv("GATEWAY_PORT")
	if port == "" {
		port = "8080"
	}

	srv := NewServer()

	relayURL := os.Getenv("RELAY_URL")
	if relayURL != "" {
		srv.relayURL = relayURL
		go srv.connectRelay()
	}

	if srv.workerURL != "" {
		go srv.cleanupLoop()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", srv.handleHealth)
	mux.HandleFunc("/ws", srv.handleWebSocket)
	mux.HandleFunc("/api/rooms", srv.handleRooms)
	mux.HandleFunc("/api/rooms/", srv.handleRoomSub)

	addr := fmt.Sprintf(":%s", port)

	tlsCert := os.Getenv("TLS_CERT")
	tlsKey := os.Getenv("TLS_KEY")

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("received %s, shutting down gracefully...", sig)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := httpSrv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown error: %v", err)
		}
	}()

	log.Printf("gateway listening on %s", addr)
	if srv.workerURL != "" {
		log.Printf("worker integration enabled: %s", srv.workerURL)
	}
	var err error
	if tlsCert != "" && tlsKey != "" {
		log.Printf("TLS enabled")
		err = httpSrv.ListenAndServeTLS(tlsCert, tlsKey)
	} else {
		err = httpSrv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
	log.Printf("gateway stopped")
}

// connectRelay dials the relay and reads messages in a loop with reconnect backoff.
func (s *Server) connectRelay() {
	backoff := time.Second
	maxBackoff := 30 * time.Second

	for {
		log.Printf("connecting to relay at %s", s.relayURL)
		conn, _, err := websocket.DefaultDialer.Dial(s.relayURL, nil)
		if err != nil {
			log.Printf("relay dial error: %v (retry in %v)", err, backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		log.Printf("connected to relay at %s", s.relayURL)
		backoff = time.Second

		s.relayMu.Lock()
		s.relayConn = conn
		s.relayMu.Unlock()

		// Read loop: relay forwards messages from other gateways
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("relay read error: %v", err)
				break
			}

			var env protocol.Envelope
			if err := json.Unmarshal(msg, &env); err != nil {
				log.Printf("invalid relay envelope: %v", err)
				continue
			}

			// Broadcast to local peers, excluding the original sender (env.ID)
			s.broadcast(env.Room, env, env.ID)
		}

		s.relayMu.Lock()
		s.relayConn = nil
		s.relayMu.Unlock()
		conn.Close()

		log.Printf("relay disconnected, reconnecting in %v", backoff)
		time.Sleep(backoff)
	}
}

// forwardToRelay sends an envelope to the relay. No-op if not connected.
func (s *Server) forwardToRelay(env protocol.Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		log.Printf("relay marshal error: %v", err)
		return
	}

	s.relayMu.Lock()
	defer s.relayMu.Unlock()

	if s.relayConn == nil {
		return
	}

	if err := s.relayConn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("relay write error: %v", err)
	}
}

// submitJob sends a job to the worker service.
func (s *Server) submitJob(jobType string, data map[string]interface{}) error {
	if s.workerURL == "" {
		return fmt.Errorf("worker URL not configured")
	}
	body, err := json.Marshal(map[string]interface{}{
		"type": jobType,
		"data": data,
	})
	if err != nil {
		return err
	}
	resp, err := s.workerClient.Post(s.workerURL+"/jobs", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("worker returned status %d", resp.StatusCode)
	}
	return nil
}

// cleanupLoop periodically submits room:cleanup jobs to the worker.
func (s *Server) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		gatewayPort := os.Getenv("GATEWAY_PORT")
		if gatewayPort == "" {
			gatewayPort = "8080"
		}
		gatewayURL := fmt.Sprintf("http://localhost:%s", gatewayPort)

		err := s.submitJob("room:cleanup", map[string]interface{}{
			"gatewayURL": gatewayURL,
		})
		if err != nil {
			log.Printf("failed to submit room:cleanup job: %v", err)
		} else {
			log.Printf("submitted room:cleanup job")
		}
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "gateway"}); err != nil {
		log.Printf("health encode error: %v", err)
	}
}

// checkAuth validates the bearer token if AUTH_TOKEN is configured.
// Checks Authorization header first, then falls back to ?token= query param
// (browsers cannot set custom headers on WebSocket connections).
// Returns true if authorized.
func (s *Server) checkAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.authToken == "" {
		return true // no auth configured — dev mode
	}
	// Try Authorization header first
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	// Fall back to query parameter for WebSocket connections
	if token == "" || token == r.Header.Get("Authorization") {
		token = r.URL.Query().Get("token")
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.authToken)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func (s *Server) handleRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.checkAuth(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	snapshots := s.store.RoomsWithCounts()
	result := make([]map[string]interface{}, 0, len(snapshots))
	for _, snap := range snapshots {
		result = append(result, map[string]interface{}{
			"name":  snap.Name,
			"count": snap.Count,
		})
	}
	if err := json.NewEncoder(w).Encode(map[string]interface{}{"rooms": result, "count": len(result)}); err != nil {
		log.Printf("rooms encode error: %v", err)
	}
}

// handleRoomSub handles /api/rooms/{name}/info and /api/rooms/{name}/cleanup
func (s *Server) handleRoomSub(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	// Parse: /api/rooms/{name}/info or /api/rooms/{name}/cleanup
	path := strings.TrimPrefix(r.URL.Path, "/api/rooms/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) != 2 || parts[0] == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	roomName, err := url.PathUnescape(parts[0])
	if err != nil {
		http.Error(w, "invalid room name encoding", http.StatusBadRequest)
		return
	}
	action := parts[1]

	switch action {
	case "info":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		peers, lastActivity, exists := s.store.RoomInfo(roomName)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"peers":        peers,
			"lastActivity": lastActivity,
			"exists":       exists,
		})

	case "cleanup":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// Force-disconnect all peers in this room
		peerIDs := s.store.Peers(roomName)
		for _, pid := range peerIDs {
			s.connMu.Lock()
			p, ok := s.conns[pid]
			if ok {
				delete(s.conns, pid)
				delete(s.peerRooms, pid)
			}
			s.connMu.Unlock()

			if ok {
				s.store.Leave(roomName, pid)
				p.closeSend()
				p.conn.Close()
			}
		}
		// If room still exists with 0 peers (stale tracking), force remove via Leave with dummy
		s.store.Leave(roomName, "__cleanup__")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"room":         roomName,
			"disconnected": len(peerIDs),
		})

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	peerID := newPeerID()
	log.Printf("new connection: %s", peerID)

	// Limit max incoming message size to 1 MB
	conn.SetReadLimit(1 << 20)

	// Set initial read deadline; refreshed on each pong
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	p := newPeer(conn)
	s.connMu.Lock()
	s.conns[peerID] = p
	s.connMu.Unlock()

	// Ping ticker to detect dead connections
	pingTicker := time.NewTicker(30 * time.Second)

	defer func() {
		pingTicker.Stop()
		s.rl.remove(peerID)
		s.connMu.Lock()
		room := s.peerRooms[peerID]
		delete(s.conns, peerID)
		delete(s.peerRooms, peerID)
		s.connMu.Unlock()

		if room != "" {
			s.store.Leave(room, peerID)
			s.broadcastPresence(room)
			s.forwardToRelay(protocol.Envelope{
				Type:      protocol.TypeLeave,
				Room:      room,
				ID:        peerID,
				Timestamp: time.Now().UnixMilli(),
			})
		}
		p.closeSend()
		conn.Close()
		log.Printf("disconnected: %s", peerID)
	}()

	// Send periodic pings via control write (bypasses send queue).
	// stopPing signals the goroutine to exit when the connection closes.
	pingDone := make(chan struct{})
	stopPing := make(chan struct{})
	go func() {
		defer close(pingDone)
		for {
			select {
			case <-stopPing:
				return
			case <-pingTicker.C:
				if err := p.writeControl(websocket.PingMessage, nil); err != nil {
					return
				}
			}
		}
	}()

	defer func() {
		close(stopPing)
		<-pingDone
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("read error (%s): %v", peerID, err)
			break
		}

		var env protocol.Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			log.Printf("invalid envelope from %s: %v", peerID, err)
			s.sendError(p, "invalid message format")
			continue
		}

		// Validate room name for types that require one
		if env.Type == protocol.TypeJoin || env.Type == protocol.TypeLeave || env.Type == protocol.TypeChat || env.Type == protocol.TypeMedia {
			if reason := validateRoomName(env.Room); reason != "" {
				s.sendError(p, reason)
				continue
			}
		}

		switch env.Type {
		case protocol.TypeJoin:
			// Atomically read previous room and update mapping
			s.connMu.Lock()
			prevRoom := s.peerRooms[peerID]
			s.peerRooms[peerID] = env.Room
			s.connMu.Unlock()

			if prevRoom != "" && prevRoom != env.Room {
				s.store.Leave(prevRoom, peerID)
				s.broadcastPresence(prevRoom)
			}

			s.store.Join(env.Room, peerID)
			s.broadcastPresence(env.Room)
			s.forwardToRelay(protocol.Envelope{
				Type:      protocol.TypeJoin,
				Room:      env.Room,
				ID:        peerID,
				Timestamp: time.Now().UnixMilli(),
			})

		case protocol.TypeLeave:
			s.store.Leave(env.Room, peerID)
			s.connMu.Lock()
			delete(s.peerRooms, peerID)
			s.connMu.Unlock()
			s.broadcastPresence(env.Room)
			s.forwardToRelay(protocol.Envelope{
				Type:      protocol.TypeLeave,
				Room:      env.Room,
				ID:        peerID,
				Timestamp: time.Now().UnixMilli(),
			})

		case protocol.TypeChat, protocol.TypeMedia:
			if !s.rl.allow(peerID) {
				s.sendError(p, "rate limit exceeded — slow down")
				continue
			}
			s.connMu.RLock()
			inRoom := s.peerRooms[peerID]
			s.connMu.RUnlock()
			if inRoom == "" {
				s.sendError(p, "must join a room before sending messages")
				continue
			}
			// Override client-supplied room with the server-authoritative room
			// to prevent broadcasting to a room the peer hasn't joined.
			env.Room = inRoom
			env.ID = peerID
			env.Timestamp = time.Now().UnixMilli()
			s.broadcast(inRoom, env, peerID)
			s.forwardToRelay(env)

		case protocol.TypePresence:
			// Server-generated only, ignore from clients

		default:
			s.sendError(p, fmt.Sprintf("unknown message type: %s", env.Type))
		}
	}
}

func newPeerID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	// Format as UUID v4
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

const maxRoomNameLen = 64

// roomNameRe allows alphanumeric, hyphens, underscores, spaces, and common punctuation.
var roomNameRe = regexp.MustCompile(`^[\p{L}\p{N} _\-\.]+$`)

func validateRoomName(name string) string {
	if name == "" {
		return "room name is required"
	}
	if utf8.RuneCountInString(name) > maxRoomNameLen {
		return fmt.Sprintf("room name exceeds %d characters", maxRoomNameLen)
	}
	if !roomNameRe.MatchString(name) {
		return "room name contains invalid characters"
	}
	return ""
}

func (s *Server) sendError(p *peer, msg string) {
	env := protocol.Envelope{
		Type:      protocol.TypeError,
		Payload:   msg,
		Timestamp: time.Now().UnixMilli(),
	}
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	p.enqueue(data)
}

// signEnvelope computes an HMAC-SHA256 over the envelope's core fields
// using the server key. The server can verify message integrity by
// recomputing and comparing the signature.
func (s *Server) signEnvelope(env *protocol.Envelope) {
	sig := tccrypto.SignHMAC(
		s.serverKey,
		env.ID,
		string(env.Type),
		env.Room,
		env.Payload,
		fmt.Sprintf("%d", env.Timestamp),
	)
	env.Sig = fmt.Sprintf("%x", sig)
}

func (s *Server) broadcast(room string, env protocol.Envelope, excludePeerID string) {
	peers := s.store.Peers(room)

	s.connMu.RLock()
	targets := make(map[string]*peer, len(peers))
	for _, id := range peers {
		if id == excludePeerID {
			continue
		}
		if p, ok := s.conns[id]; ok {
			targets[id] = p
		}
	}
	s.connMu.RUnlock()

	// Sign the envelope with the server key for integrity verification
	s.signEnvelope(&env)

	data, err := json.Marshal(env)
	if err != nil {
		log.Printf("marshal error: %v", err)
		return
	}

	for _, p := range targets {
		p.enqueue(data)
	}
}

func (s *Server) broadcastPresence(room string) {
	count := s.store.Count(room)
	payload, err := json.Marshal(protocol.PresencePayload{
		Room:  room,
		Count: count,
	})
	if err != nil {
		log.Printf("presence marshal error: %v", err)
		return
	}
	env := protocol.Envelope{
		Type:      protocol.TypePresence,
		Room:      room,
		Payload:   string(payload),
		Timestamp: time.Now().UnixMilli(),
	}
	s.broadcast(room, env, "")
}
