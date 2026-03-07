package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
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
	maxRooms         = 10000 // Maximum concurrent rooms to prevent DoS via unbounded room creation

	// Allowed room TTL values (seconds)
	ttl15Min  int64 = 900
	ttl1Hour  int64 = 3600
	ttl4Hour  int64 = 14400
	ttl24Hour int64 = 86400
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
	rl := &rateLimiter{
		buckets:  make(map[string]*tokenBucket),
		rate:     rate,
		interval: interval,
		burst:    burst,
	}
	go rl.pruneLoop()
	return rl
}

// pruneLoop periodically removes stale buckets that haven't been used
// for longer than the refill interval * burst (i.e., fully replenished and idle).
// This prevents unbounded growth from abnormal disconnects or missed cleanup.
func (rl *rateLimiter) pruneLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		staleThreshold := rl.interval * time.Duration(rl.burst)
		if staleThreshold < time.Minute {
			staleThreshold = time.Minute
		}
		for id, b := range rl.buckets {
			if now.Sub(b.lastFill) > staleThreshold {
				delete(rl.buckets, id)
			}
		}
		rl.mu.Unlock()
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

	// Refill tokens based on elapsed time, preserving sub-interval remainder
	elapsed := time.Since(b.lastFill)
	intervals := int(elapsed / rl.interval)
	refill := intervals * rl.rate
	if refill > 0 {
		b.tokens += refill
		if b.tokens > rl.burst {
			b.tokens = rl.burst
		}
		// Advance lastFill by exact intervals consumed, preserving fractional remainder
		b.lastFill = b.lastFill.Add(time.Duration(intervals) * rl.interval)
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

// relayInstance represents one relay backend connection.
type relayInstance struct {
	url  string
	conn *websocket.Conn
	mu   sync.Mutex
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

	// Multi-relay support: multiple relay instances for horizontal scaling.
	// Messages are routed to relays via consistent hashing on room name.
	relays    []*relayInstance
	relaysMu  sync.RWMutex

	rl        *rateLimiter
	typingRL  *rateLimiter // separate rate limiter for typing indicators
	signalRL  *rateLimiter // WebRTC signaling rate limiter (higher burst for ICE trickle)
	authToken string // optional — set via AUTH_TOKEN env var
	serverKey []byte // AES-256-GCM key for server-side envelope signing

	workerURL    string // optional — set via WORKER_URL env var
	workerClient *http.Client

	startTime time.Time // set in NewServer for uptime tracking
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
		slog.Error("failed to generate server key", "error", err)
		os.Exit(1)
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
		typingRL:  newRateLimiter(1, 2*time.Second, 3),
		signalRL:  newRateLimiter(50, time.Second, 100), // ICE trickle needs high burst
		authToken: os.Getenv("AUTH_TOKEN"),
		serverKey: serverKey,
		workerURL:    os.Getenv("WORKER_URL"),
		workerClient: &http.Client{Timeout: 10 * time.Second},
		startTime:    time.Now(),
	}
}

func main() {
	// Structured JSON logging
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	port := os.Getenv("GATEWAY_PORT")
	if port == "" {
		port = "8080"
	}

	srv := NewServer()

	// Support multiple relay instances via RELAY_URLS (comma-separated) or single RELAY_URL
	relayURLs := os.Getenv("RELAY_URLS")
	if relayURLs == "" {
		// Fall back to single RELAY_URL for backwards compatibility
		if single := os.Getenv("RELAY_URL"); single != "" {
			relayURLs = single
		}
	}
	if relayURLs != "" {
		for _, u := range strings.Split(relayURLs, ",") {
			u = strings.TrimSpace(u)
			if u == "" {
				continue
			}
			ri := &relayInstance{url: u}
			srv.relays = append(srv.relays, ri)
		}
		// Keep single relay fields for backward compat
		if len(srv.relays) > 0 {
			srv.relayURL = srv.relays[0].url
		}
		for _, ri := range srv.relays {
			go srv.connectRelayInstance(ri)
		}
		slog.Info("relay instances configured", "count", len(srv.relays))
	}

	if srv.workerURL != "" {
		go srv.cleanupLoop()
	}

	go srv.ttlExpiryLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", srv.handleHealth)
	mux.HandleFunc("/health/all", srv.handleHealthAll)
	mux.HandleFunc("/metrics", srv.handleMetrics)
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
		slog.Info("received signal, shutting down", "signal", sig)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := httpSrv.Shutdown(ctx); err != nil {
			slog.Error("graceful shutdown error", "error", err)
		}
	}()

	slog.Info("gateway listening", "addr", addr)
	if srv.workerURL != "" {
		slog.Info("worker integration enabled", "url", srv.workerURL)
	}
	var err error
	if tlsCert != "" && tlsKey != "" {
		slog.Info("TLS enabled")
		err = httpSrv.ListenAndServeTLS(tlsCert, tlsKey)
	} else {
		err = httpSrv.ListenAndServe()
	}
	if err != nil && err != http.ErrServerClosed {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
	slog.Info("gateway stopped")
}

// connectRelayInstance dials a single relay instance and reads messages with reconnect backoff.
func (s *Server) connectRelayInstance(ri *relayInstance) {
	backoff := time.Second
	maxBackoff := 30 * time.Second

	for {
		slog.Info("connecting to relay instance", "url", ri.url)
		conn, _, err := websocket.DefaultDialer.Dial(ri.url, nil)
		if err != nil {
			slog.Warn("relay instance dial error", "url", ri.url, "error", err, "retry_in", backoff)
			time.Sleep(backoff)
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		slog.Info("connected to relay instance", "url", ri.url)
		backoff = time.Second

		ri.mu.Lock()
		ri.conn = conn
		ri.mu.Unlock()

		// Also update legacy single-relay conn for the first instance
		if len(s.relays) > 0 && s.relays[0] == ri {
			s.relayMu.Lock()
			s.relayConn = conn
			s.relayMu.Unlock()
		}

		// Read loop
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				slog.Error("relay instance read error", "url", ri.url, "error", err)
				break
			}
			var env protocol.Envelope
			if err := json.Unmarshal(msg, &env); err != nil {
				slog.Warn("invalid relay envelope", "error", err)
				continue
			}
			s.broadcast(env.Room, env, env.ID)
		}

		ri.mu.Lock()
		ri.conn = nil
		ri.mu.Unlock()

		if len(s.relays) > 0 && s.relays[0] == ri {
			s.relayMu.Lock()
			s.relayConn = nil
			s.relayMu.Unlock()
		}
		conn.Close()

		slog.Warn("relay instance disconnected, reconnecting", "url", ri.url, "delay", backoff)
		time.Sleep(backoff)
	}
}

// relayForRoom selects a relay instance for a room using consistent hashing.
// This ensures all messages for a given room go to the same relay for proper fan-out.
func (s *Server) relayForRoom(room string) *relayInstance {
	s.relaysMu.RLock()
	defer s.relaysMu.RUnlock()
	if len(s.relays) == 0 {
		return nil
	}
	// FNV-1a hash for fast, well-distributed selection
	var h uint32 = 2166136261
	for i := 0; i < len(room); i++ {
		h ^= uint32(room[i])
		h *= 16777619
	}
	return s.relays[h%uint32(len(s.relays))]
}

// forwardToRelay sends an envelope to the appropriate relay instance based on room.
// With multiple relays, uses consistent hashing for load balancing.
// Falls back to legacy single-relay connection if no multi-relay is configured.
func (s *Server) forwardToRelay(env protocol.Envelope) {
	data, err := json.Marshal(env)
	if err != nil {
		slog.Error("relay marshal error", "error", err)
		return
	}

	// Multi-relay path: route by room hash
	if ri := s.relayForRoom(env.Room); ri != nil {
		ri.mu.Lock()
		defer ri.mu.Unlock()
		if ri.conn == nil {
			return
		}
		ri.conn.SetWriteDeadline(time.Now().Add(writeWaitTimeout))
		if err := ri.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			slog.Error("relay instance write error", "url", ri.url, "error", err)
		}
		return
	}

	// Legacy single-relay fallback
	s.relayMu.Lock()
	defer s.relayMu.Unlock()

	if s.relayConn == nil {
		return
	}

	s.relayConn.SetWriteDeadline(time.Now().Add(writeWaitTimeout))
	if err := s.relayConn.WriteMessage(websocket.TextMessage, data); err != nil {
		slog.Error("relay write error", "error", err)
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

// ttlExpiryLoop checks for expired rooms every 30 seconds and disconnects all peers.
func (s *Server) ttlExpiryLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		expired := s.store.ExpiredRooms()
		for _, roomName := range expired {
			slog.Info("room TTL expired", "room", roomName)
			// Broadcast system message before disconnecting
			sysPayload := `{"text":"room expired — TTL reached","encrypted":false}`
			sysEnv := protocol.Envelope{
				Type:      protocol.TypeChat,
				Room:      roomName,
				Payload:   sysPayload,
				ID:        "__system__",
				Timestamp: time.Now().UnixMilli(),
			}
			s.broadcast(roomName, sysEnv, "")

			// Disconnect all peers
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
			// Force cleanup any remaining state
			s.store.Leave(roomName, "__ttl_cleanup__")
		}
	}
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
			slog.Error("failed to submit room:cleanup job", "error", err)
		} else {
			slog.Info("submitted room:cleanup job")
		}
	}
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "gateway"}); err != nil {
		slog.Error("health encode error", "error", err)
	}
}

func (s *Server) handleHealthAll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type serviceStatus struct {
		Status  string `json:"status"`
		Service string `json:"service"`
	}

	result := map[string]interface{}{
		"gateway": serviceStatus{Status: "ok", Service: "gateway"},
	}

	// Check relay health
	relayHealthURL := os.Getenv("RELAY_HEALTH_URL")
	if relayHealthURL == "" {
		relayHealthURL = "http://relay:9001/health"
	}
	if resp, err := s.workerClient.Get(relayHealthURL); err != nil {
		result["relay"] = serviceStatus{Status: "unreachable", Service: "relay"}
	} else {
		var sr serviceStatus
		json.NewDecoder(resp.Body).Decode(&sr)
		resp.Body.Close()
		if sr.Status == "" {
			sr.Status = "ok"
		}
		sr.Service = "relay"
		result["relay"] = sr
	}

	// Check worker health
	if s.workerURL != "" {
		if resp, err := s.workerClient.Get(s.workerURL + "/health"); err != nil {
			result["worker"] = serviceStatus{Status: "unreachable", Service: "worker"}
		} else {
			var sr serviceStatus
			json.NewDecoder(resp.Body).Decode(&sr)
			resp.Body.Close()
			if sr.Status == "" {
				sr.Status = "ok"
			}
			sr.Service = "worker"
			result["worker"] = sr
		}
	}

	// Determine overall status
	overall := "ok"
	for _, v := range result {
		if ss, ok := v.(serviceStatus); ok && ss.Status != "ok" {
			overall = "degraded"
			break
		}
	}
	result["status"] = overall

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// handleMetrics returns JSON with server metrics for monitoring and alerting.
// Requires auth if AUTH_TOKEN is configured.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.checkAuth(w, r) {
		return
	}

	// Active connections
	s.connMu.RLock()
	activeConnections := len(s.conns)
	s.connMu.RUnlock()

	// Rooms with peer counts (single lock acquisition)
	roomSnapshots := s.store.RoomsWithCounts()
	activeRooms := len(roomSnapshots)
	// Expose only peer counts per room (without room names) for privacy
	roomPeerCounts := make([]int, 0, len(roomSnapshots))
	for _, snap := range roomSnapshots {
		roomPeerCounts = append(roomPeerCounts, snap.Count)
	}

	// Relay connectivity: any relay instance has a live connection
	s.relaysMu.RLock()
	relayCount := len(s.relays)
	relayConnected := false
	for _, ri := range s.relays {
		ri.mu.Lock()
		if ri.conn != nil {
			relayConnected = true
		}
		ri.mu.Unlock()
		if relayConnected {
			break
		}
	}
	s.relaysMu.RUnlock()

	// Rate limiter bucket count
	s.rl.mu.Lock()
	rateLimiterBuckets := len(s.rl.buckets)
	s.rl.mu.Unlock()

	// Worker configured
	workerConfigured := s.workerURL != ""

	payload := map[string]interface{}{
		"uptime_seconds":           time.Since(s.startTime).Seconds(),
		"active_connections":       activeConnections,
		"active_rooms":             activeRooms,
		"room_peer_counts":         roomPeerCounts,
		"relay_connected":          relayConnected,
		"relay_count":              relayCount,
		"rate_limiter_buckets":     rateLimiterBuckets,
		"worker_url":               workerConfigured,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("metrics encode error", "error", err)
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
		slog.Error("rooms encode error", "error", err)
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

	case "ttl":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ttl, createdAt, exists := s.store.RoomTTL(roomName)
		var expiresAt int64
		if exists && ttl > 0 {
			expiresAt = createdAt.Add(time.Duration(ttl) * time.Second).UnixMilli()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ttlSeconds": ttl,
			"expiresAt":  expiresAt,
			"exists":     exists,
		})

	case "broadcast":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Type    string `json:"type"`
			Payload string `json:"payload"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB limit
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		// Only allow safe broadcast types to prevent injection of chat/media messages
		allowedBroadcastTypes := map[protocol.MessageType]bool{
			protocol.TypeError:    true,
			protocol.TypePresence: true,
		}
		msgType := protocol.MessageType(body.Type)
		if !allowedBroadcastTypes[msgType] {
			http.Error(w, fmt.Sprintf("broadcast type %q not allowed", body.Type), http.StatusBadRequest)
			return
		}
		env := protocol.Envelope{
			Type:      msgType,
			Room:      roomName,
			Payload:   body.Payload,
			ID:        "__worker__",
			Timestamp: time.Now().UnixMilli(),
		}
		s.broadcast(roomName, env, "")
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "broadcast sent", "room": roomName})

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
		slog.Error("upgrade error", "error", err)
		return
	}

	peerID := newPeerID()
	slog.Info("new connection", "peer", peerID)

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

	// Send welcome message with peer's assigned ID
	welcomeEnv := protocol.Envelope{
		Type:      protocol.TypeWelcome,
		ID:        peerID,
		Timestamp: time.Now().UnixMilli(),
	}
	if welcomeData, err := json.Marshal(welcomeEnv); err == nil {
		p.enqueue(welcomeData)
	}

	// Ping ticker to detect dead connections
	pingTicker := time.NewTicker(30 * time.Second)

	defer func() {
		pingTicker.Stop()
		s.rl.remove(peerID)
		s.typingRL.remove(peerID)
		s.signalRL.remove(peerID)
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
		slog.Info("disconnected", "peer", peerID)
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
			slog.Error("read error", "peer", peerID, "error", err)
			break
		}

		var env protocol.Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			slog.Warn("invalid envelope", "peer", peerID, "error", err)
			s.sendError(p, "invalid message format")
			continue
		}

		// Validate room name for types that require one
		if env.Type == protocol.TypeJoin || env.Type == protocol.TypeLeave || env.Type == protocol.TypeChat || env.Type == protocol.TypeMedia || env.Type == protocol.TypeTyping || env.Type == protocol.TypeReceipt || env.Type == protocol.TypeKeyRotation || env.Type == protocol.TypeSignal {
			if reason := validateRoomName(env.Room); reason != "" {
				s.sendError(p, reason)
				continue
			}
		}

		switch env.Type {
		case protocol.TypeJoin:
			// Pre-check room limit (still slightly racy but JoinWithTTL is atomic for room+TTL)
			if s.store.Count(env.Room) == 0 && s.store.RoomCount() >= maxRooms {
				s.sendError(p, "room limit reached — try again later")
				continue
			}

			// Parse optional nickname and TTL from join payload
			var jp protocol.JoinPayload
			if env.Payload != "" {
				_ = json.Unmarshal([]byte(env.Payload), &jp)
			}

			// Determine TTL for atomic join (only allowed values)
			var ttlForJoin int64
			allowed := map[int64]bool{ttl15Min: true, ttl1Hour: true, ttl4Hour: true, ttl24Hour: true}
			if jp.TTLSeconds > 0 && allowed[jp.TTLSeconds] {
				ttlForJoin = jp.TTLSeconds
			}

			// Atomically read previous room and update mapping
			s.connMu.Lock()
			prevRoom := s.peerRooms[peerID]
			s.peerRooms[peerID] = env.Room
			s.connMu.Unlock()

			if prevRoom != "" && prevRoom != env.Room {
				s.store.Leave(prevRoom, peerID)
				s.broadcastPresence(prevRoom)
			}

			// Atomic join + TTL — eliminates TOCTOU race and TTL gap
			s.store.JoinWithTTL(env.Room, peerID, ttlForJoin)

			nick := sanitizeNickname(jp.Nickname)
			if nick != "" {
				s.store.SetNickname(env.Room, peerID, nick)
			}

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

		case protocol.TypeTyping:
			s.connMu.RLock()
			inRoom := s.peerRooms[peerID]
			s.connMu.RUnlock()
			if inRoom == "" {
				s.sendError(p, "must join a room before sending typing")
				continue
			}
			if !s.typingRL.allow(peerID) {
				continue // silently drop excess typing indicators
			}
			env.Room = inRoom
			env.ID = peerID
			env.Timestamp = time.Now().UnixMilli()
			// Typing indicators are NOT forwarded to relay — local gateway only
			s.broadcast(inRoom, env, peerID)

		case protocol.TypeReceipt:
			s.connMu.RLock()
			inRoom := s.peerRooms[peerID]
			s.connMu.RUnlock()
			if inRoom == "" {
				s.sendError(p, "must join a room before sending receipts")
				continue
			}
			env.Room = inRoom
			env.ID = peerID
			env.Timestamp = time.Now().UnixMilli()
			s.broadcast(inRoom, env, peerID)

		case protocol.TypeKeyRotation:
			if !s.rl.allow(peerID) {
				s.sendError(p, "rate limit exceeded — slow down")
				continue
			}
			s.connMu.RLock()
			inRoom := s.peerRooms[peerID]
			s.connMu.RUnlock()
			if inRoom == "" {
				s.sendError(p, "must join a room before sending key rotation")
				continue
			}
			env.Room = inRoom
			env.ID = peerID
			env.Timestamp = time.Now().UnixMilli()
			s.broadcast(inRoom, env, peerID)
			s.forwardToRelay(env)

		case protocol.TypeSignal:
			s.connMu.RLock()
			inRoom := s.peerRooms[peerID]
			s.connMu.RUnlock()
			if inRoom == "" {
				s.sendError(p, "must join a room before sending signals")
				continue
			}
			if !s.signalRL.allow(peerID) {
				continue // silently drop excess signals
			}
			if env.To == "" {
				s.sendError(p, "signal requires target peer")
				continue
			}
			env.Room = inRoom
			env.ID = peerID
			env.Timestamp = time.Now().UnixMilli()
			// Forward directly to target peer — must be in the same room
			s.connMu.RLock()
			targetPeer, ok := s.conns[env.To]
			targetRoom := s.peerRooms[env.To]
			s.connMu.RUnlock()
			if ok && targetRoom == inRoom {
				data, err := json.Marshal(env)
				if err == nil {
					targetPeer.enqueue(data)
				}
			} else {
				// Target peer not on this instance — forward to relay for cross-gateway delivery
				s.forwardToRelay(env)
			}

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

// sanitizeNickname cleans a nickname: strips control chars, limits to 32 runes.
func sanitizeNickname(nick string) string {
	var b strings.Builder
	count := 0
	for _, r := range nick {
		if count >= 32 {
			break
		}
		// Strip control characters
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
		count++
	}
	return strings.TrimSpace(b.String())
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
		slog.Error("marshal error", "error", err)
		return
	}

	for _, p := range targets {
		p.enqueue(data)
	}
}

func (s *Server) broadcastPresence(room string) {
	peers := s.store.PeersWithNicknames(room)
	count := len(peers)
	pp := protocol.PresencePayload{
		Room:  room,
		Count: count,
		Peers: peers,
	}
	if ttl, createdAt, ok := s.store.RoomTTL(room); ok && ttl > 0 {
		pp.TTLSeconds = ttl
		pp.ExpiresAt = createdAt.Add(time.Duration(ttl) * time.Second).UnixMilli()
	}
	payload, err := json.Marshal(pp)
	if err != nil {
		slog.Error("presence marshal error", "error", err)
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
