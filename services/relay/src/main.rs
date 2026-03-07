use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, RwLock, Mutex};
use tokio_tungstenite::accept_hdr_async;
use tracing::{info, warn, error};
use trapchat_io::Frame;
use trapchat_protocol::{Message, MessageType, RoomEvent};

/// Frame type constants for the binary framing protocol.
const FRAME_TYPE_MESSAGE: u8 = 1;
const FRAME_TYPE_EVENT: u8 = 2;

/// Relay-specific error types.
#[derive(Debug, thiserror::Error)]
enum RelayError {
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("room validation: {0}")]
    RoomValidation(String),

    #[error("connection limit reached: {current}/{max}")]
    ConnectionLimit { current: usize, max: usize },

    #[error("room limit reached: {current}/{max}")]
    RoomLimit { current: usize, max: usize },

    #[error("frame error: {0}")]
    Frame(#[from] trapchat_io::IoError),
}

/// Encode a Message into a Frame for structured logging or binary transport.
fn frame_message(msg: &Message) -> Result<Frame, RelayError> {
    let payload = serde_json::to_vec(msg)?;
    Ok(Frame::new(FRAME_TYPE_MESSAGE, payload))
}

/// Encode a RoomEvent into a Frame for structured logging or binary transport.
fn frame_event(event: &RoomEvent) -> Result<Frame, RelayError> {
    let payload = serde_json::to_vec(event)?;
    Ok(Frame::new(FRAME_TYPE_EVENT, payload))
}

/// Bounded channel capacity per peer. Slow consumers are disconnected when full.
const PEER_CHANNEL_CAP: usize = 256;
/// Maximum number of concurrent rooms to prevent memory exhaustion.
const MAX_ROOMS: usize = 10_000;
/// Maximum concurrent connections.
const MAX_CONNECTIONS: usize = 10_000;
/// Max new connections per IP per second.
const MAX_CONN_PER_IP_PER_SEC: usize = 10;
/// Maximum room name length in Unicode scalar values.
const MAX_ROOM_NAME_LEN: usize = 64;

/// Validate room name: must be non-empty, within length limit, and contain only
/// letters, numbers, spaces, hyphens, underscores, and dots (matching gateway rules).
fn validate_room_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("room name is required");
    }
    if name.chars().count() > MAX_ROOM_NAME_LEN {
        return Err("room name too long");
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.') {
        return Err("room name contains invalid characters");
    }
    Ok(())
}

/// Per-IP connection rate limiter using a sliding window.
struct IpRateLimiter {
    buckets: HashMap<IpAddr, Vec<Instant>>,
}

impl IpRateLimiter {
    fn new() -> Self {
        Self { buckets: HashMap::new() }
    }

    fn allow(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let window = std::time::Duration::from_secs(1);
        let timestamps = self.buckets.entry(ip).or_default();
        timestamps.retain(|t| now.duration_since(*t) < window);
        if timestamps.len() >= MAX_CONN_PER_IP_PER_SEC {
            return false;
        }
        timestamps.push(now);
        true
    }

    /// Remove entries with no recent timestamps to prevent unbounded growth.
    fn prune(&mut self) {
        self.buckets.retain(|_, v| !v.is_empty());
    }
}

type PeerTx = mpsc::Sender<tokio_tungstenite::tungstenite::Message>;
type Room = Arc<RwLock<HashMap<String, PeerTx>>>;
type RoomMap = Arc<RwLock<HashMap<String, Room>>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tokio::spawn(health_server());

    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "0.0.0.0:9000".to_string());
    let listener = TcpListener::bind(&addr).await.expect("failed to bind relay");
    info!("relay listening on {}", addr);

    let rooms: RoomMap = Arc::new(RwLock::new(HashMap::new()));
    let conn_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ip_limiter = Arc::new(Mutex::new(IpRateLimiter::new()));

    let allowed_origins: Vec<String> = std::env::var("RELAY_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| String::new())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Periodically prune stale IP rate limiter entries
    {
        let limiter = ip_limiter.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                limiter.lock().await.prune();
            }
        });
    }

    let shutdown_signal = async {
        let _ = tokio::signal::ctrl_c().await;
        info!("received shutdown signal, stopping relay...");
    };
    tokio::pin!(shutdown_signal);

    loop {
        let (stream, peer) = tokio::select! {
            result = listener.accept() => match result {
                Ok(v) => v,
                Err(e) => {
                    error!("accept error: {}", e);
                    continue;
                }
            },
            _ = &mut shutdown_signal => {
                info!("relay shutting down gracefully");
                break;
            }
        };
        let current = conn_count.load(std::sync::atomic::Ordering::Relaxed);
        if current >= MAX_CONNECTIONS {
            let relay_err = RelayError::ConnectionLimit { current, max: MAX_CONNECTIONS };
            warn!("{}, rejecting {}", relay_err, peer);
            drop(stream);
            continue;
        }

        // Per-IP rate limit on new connections
        {
            let mut limiter = ip_limiter.lock().await;
            if !limiter.allow(peer.ip()) {
                warn!("per-IP connection rate limit exceeded for {}, rejecting", peer.ip());
                drop(stream);
                continue;
            }
        }

        conn_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        info!("new connection from {}", peer);
        let rooms = rooms.clone();
        let conn_count = conn_count.clone();
        let allowed_origins = allowed_origins.clone();
        tokio::spawn(async move {
            handle_connection(stream, rooms, &allowed_origins).await;
            conn_count.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        });
    }
}

async fn handle_connection(stream: tokio::net::TcpStream, rooms: RoomMap, allowed_origins: &[String]) {
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    let allowed = allowed_origins.to_vec();
    let callback = |req: &Request, response: Response| -> Result<Response, tokio_tungstenite::tungstenite::http::Response<Option<String>>> {
        if !allowed.is_empty() {
            let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
            if !allowed.iter().any(|o| o == origin) {
                warn!("rejected origin: {}", origin);
                let reject = tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("forbidden origin".to_string()))
                    .unwrap();
                return Err(reject);
            }
        }
        Ok(response)
    };

    let ws = match accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("websocket handshake failed: {}", e);
            return;
        }
    };

    let peer_id = uuid::Uuid::new_v4().to_string();
    let (mut sink, mut source) = ws.split();

    // Write task: drains bounded channel into websocket sink
    let (tx, mut rx) = mpsc::channel::<tokio_tungstenite::tungstenite::Message>(PEER_CHANNEL_CAP);
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut current_room: Option<String> = None;

    // Read task
    while let Some(msg) = source.next().await {
        match msg {
            Ok(msg) if msg.is_text() || msg.is_binary() => {
                let data = msg.into_data();
                // Reject oversized messages before any further allocation
                if data.len() > 1024 * 1024 {
                    warn!("oversized message from {} ({} bytes), dropping", peer_id, data.len());
                    continue;
                }
                let decoded: Message = match serde_json::from_slice(&data) {
                    Ok(m) => m,
                    Err(_) => {
                        warn!("invalid message from {}", peer_id);
                        continue;
                    }
                };

                // Validate room name for types that reference a room
                match decoded.msg_type {
                    MessageType::Join | MessageType::Leave | MessageType::Chat | MessageType::Media => {
                        if let Err(reason) = validate_room_name(&decoded.room) {
                            let relay_err = RelayError::RoomValidation(reason.to_string());
                            warn!("from {}: {}", peer_id, relay_err);
                            let err = Message::new(
                                MessageType::Error,
                                String::new(),
                                Some(reason.to_string()),
                            );
                            if let Ok(data) = serde_json::to_string(&err) {
                                let _ = tx.try_send(tokio_tungstenite::tungstenite::Message::Text(data.into()));
                            }
                            continue;
                        }
                    }
                    _ => {}
                }

                match decoded.msg_type {
                    MessageType::Join => {
                        // Leave previous room if any
                        if let Some(ref prev) = current_room {
                            leave_room(&rooms, prev, &peer_id).await;
                        }

                        let room_name = decoded.room.clone();
                        let room_arc = {
                            let mut map = rooms.write().await;
                            let is_new = !map.contains_key(&room_name);
                            if is_new && map.len() >= MAX_ROOMS {
                                let relay_err = RelayError::RoomLimit { current: map.len(), max: MAX_ROOMS };
                                warn!("{}", relay_err);
                                let err = Message::new(
                                    MessageType::Error,
                                    room_name.clone(),
                                    Some("room limit reached".to_string()),
                                );
                                if let Ok(data) = serde_json::to_string(&err) {
                                    let _ = tx.try_send(tokio_tungstenite::tungstenite::Message::Text(data.into()));
                                }
                                continue;
                            }
                            let room_arc = map.entry(room_name.clone())
                                .or_insert_with(|| Arc::new(RwLock::new(HashMap::new())))
                                .clone();
                            if is_new {
                                let event = RoomEvent::Created {
                                    room: room_name.clone(),
                                };
                                if let Ok(frame) = frame_event(&event) {
                                    info!("event frame_type={} len={} {}", frame.frame_type, frame.payload.len(), String::from_utf8_lossy(&frame.payload));
                                }

                            }
                            room_arc
                        };
                        {
                            let mut room = room_arc.write().await;
                            room.insert(peer_id.clone(), tx.clone());
                        }
                        current_room = Some(room_name.clone());

                        let peer_count = room_arc.read().await.len();
                        let event = RoomEvent::Joined {
                            room: room_name.clone(),
                            peer_count,
                        };
                        if let Ok(frame) = frame_event(&event) {
                            info!("event frame_type={} len={} {}", frame.frame_type, frame.payload.len(),
                                serde_json::to_string(&event).unwrap_or_default());
                        }
                        broadcast_presence(&rooms, &room_name).await;
                    }
                    MessageType::Chat | MessageType::Media => {
                        if let Some(ref room_name) = current_room {
                            fan_out_msg(&rooms, room_name, &peer_id, &data).await;
                        }
                    }
                    MessageType::Leave => {
                        if let Some(ref room_name) = current_room {
                            leave_room(&rooms, room_name, &peer_id).await;
                            broadcast_presence(&rooms, room_name).await;
                            current_room = None;
                        }
                    }
                    MessageType::Presence | MessageType::Error => {}
                }
            }
            Err(e) => {
                error!("read error from {}: {}", peer_id, e);
                break;
            }
            _ => {}
        }
    }

    // Disconnect cleanup
    if let Some(ref room_name) = current_room {
        leave_room(&rooms, room_name, &peer_id).await;
        broadcast_presence(&rooms, room_name).await;
    }
    info!("disconnected: {}", peer_id);
}

async fn leave_room(rooms: &RoomMap, room_name: &str, peer_id: &str) {
    let room_arc = {
        let map = rooms.read().await;
        match map.get(room_name) {
            Some(r) => r.clone(),
            None => return,
        }
    };

    let count = {
        let mut room = room_arc.write().await;
        room.remove(peer_id);
        room.len()
    };

    let event = RoomEvent::Left {
        room: room_name.to_string(),
        peer_count: count,
    };
    if let Ok(frame) = frame_event(&event) {
                            info!("event frame_type={} len={} {}", frame.frame_type, frame.payload.len(),
                                serde_json::to_string(&event).unwrap_or_default());
                        }

    if count == 0 {
        // Quick check without the outer write lock to avoid blocking all rooms
        let still_empty = {
            let map = rooms.read().await;
            match map.get(room_name) {
                Some(r) => r.read().await.is_empty(),
                None => false,
            }
        };
        if still_empty {
            let mut map = rooms.write().await;
            // Re-check under write lock — another peer may have joined
            if let Some(r) = map.get(room_name) {
                if r.read().await.is_empty() {
                    map.remove(room_name);
                    let event = RoomEvent::Destroyed {
                        room: room_name.to_string(),
                    };
                    if let Ok(frame) = frame_event(&event) {
                            info!("event frame_type={} len={} {}", frame.frame_type, frame.payload.len(),
                                serde_json::to_string(&event).unwrap_or_default());
                        }
                }
            }
        }
    }
}

async fn fan_out_msg(rooms: &RoomMap, room_name: &str, sender_id: &str, data: &[u8]) {
    let room_arc = {
        let map = rooms.read().await;
        match map.get(room_name) {
            Some(r) => r.clone(),
            None => return,
        }
    };
    // Log framed message metadata for diagnostics
    if let Ok(decoded) = serde_json::from_slice::<Message>(data) {
        if let Ok(frame) = frame_message(&decoded) {
            info!("fan_out frame_type={} len={} room={}", frame.frame_type, frame.payload.len(), room_name);
        }
    }
    let msg = match String::from_utf8(data.to_vec()) {
        Ok(text) => tokio_tungstenite::tungstenite::Message::Text(text.into()),
        Err(e) => tokio_tungstenite::tungstenite::Message::Binary(e.into_bytes().into()),
    };
    let stale_peers = {
        let room = room_arc.read().await;
        let mut stale = Vec::new();
        for (id, tx) in room.iter() {
            if id != sender_id {
                match tx.try_send(msg.clone()) {
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        warn!("slow consumer {}, disconnecting", id);
                        stale.push(id.clone());
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        warn!("closed consumer {}, removing", id);
                        stale.push(id.clone());
                    }
                    Ok(_) => {}
                }
            }
        }
        stale
    };
    // Remove stale/slow consumers from the room
    if !stale_peers.is_empty() {
        let mut room = room_arc.write().await;
        for id in &stale_peers {
            room.remove(id);
        }
    }
}

async fn broadcast_presence(rooms: &RoomMap, room_name: &str) {
    let room_arc = {
        let map = rooms.read().await;
        match map.get(room_name) {
            Some(r) => r.clone(),
            None => return,
        }
    };
    // Collect senders and count under lock, then drop lock before sending
    let (senders, count) = {
        let room = room_arc.read().await;
        let count = room.len();
        let senders: Vec<(String, PeerTx)> = room.iter().map(|(id, tx)| (id.clone(), tx.clone())).collect();
        (senders, count)
    };
    let presence = Message::new(
        MessageType::Presence,
        room_name.to_string(),
        Some(serde_json::json!({"room": room_name, "count": count}).to_string()),
    );
    info!("broadcasting presence: room={} count={} payload={:?}", room_name, count, presence.payload);
    let msg = tokio_tungstenite::tungstenite::Message::Text(
        serde_json::json!({"type": "presence", "room": room_name, "count": count}).to_string().into(),
    );
    for (id, tx) in &senders {
        if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(msg.clone()) {
            warn!("slow consumer {} during presence broadcast, dropping", id);
        }
    }
}

async fn health_server() {
    let addr = std::env::var("RELAY_HEALTH_ADDR").unwrap_or_else(|_| "0.0.0.0:9001".to_string());
    let listener = TcpListener::bind(&addr).await.expect("failed to bind health");
    info!("relay health on {}", addr);

    loop {
        if let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};

                // Read the HTTP request (up to 4KB, with 5s timeout)
                let mut buf = [0u8; 4096];
                let n = match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    stream.read(&mut buf),
                )
                .await
                {
                    Ok(Ok(n)) if n > 0 => n,
                    _ => {
                        let _ = stream.shutdown().await;
                        return;
                    }
                };

                let request = String::from_utf8_lossy(&buf[..n]);

                // Parse method and path from the request line
                let response = match request.lines().next() {
                    Some(line) => {
                        let mut parts = line.split_whitespace();
                        let method = parts.next().unwrap_or("");
                        let path = parts.next().unwrap_or("");

                        if method == "GET" && (path == "/health" || path == "/") {
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"service\":\"relay\"}"
                        } else if method == "GET" {
                            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"not found\"}"
                        } else {
                            "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\n\r\n"
                        }
                    }
                    None => "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
                };

                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    }
}
