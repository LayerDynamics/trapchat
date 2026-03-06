use std::collections::HashMap;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::accept_async;
use tracing::{info, warn, error};
use trapchat_io::Frame;
use trapchat_protocol::{Message, MessageType, RoomEvent};

/// Bounded channel capacity per peer. Slow consumers are disconnected when full.
const PEER_CHANNEL_CAP: usize = 256;

type PeerTx = mpsc::Sender<tokio_tungstenite::tungstenite::Message>;
type Room = Arc<RwLock<HashMap<String, PeerTx>>>;
type RoomMap = Arc<RwLock<HashMap<String, Room>>>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
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

    while let Ok((stream, peer)) = listener.accept().await {
        info!("new connection from {}", peer);
        let rooms = rooms.clone();
        tokio::spawn(handle_connection(stream, rooms));
    }
}

async fn handle_connection(stream: tokio::net::TcpStream, rooms: RoomMap) {
    let ws = match accept_async(stream).await {
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
                // Validate size via Frame (enforces MAX_FRAME_SIZE)
                let frame = Frame::new(1, data);
                if frame.encode().len() > 1024 * 1024 {
                    warn!("oversized message from {}, dropping", peer_id);
                    continue;
                }
                let data = frame.payload;
                let decoded: Message = match serde_json::from_slice(&data) {
                    Ok(m) => m,
                    Err(_) => {
                        warn!("invalid message from {}", peer_id);
                        continue;
                    }
                };

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
                            let room_arc = map.entry(room_name.clone())
                                .or_insert_with(|| Arc::new(RwLock::new(HashMap::new())))
                                .clone();
                            if is_new {
                                let event = RoomEvent::Created {
                                    room: room_name.clone(),
                                };
                                info!("{:?}", event);
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
                        info!("{:?}", event);
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
    info!("{:?}", event);

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
                    info!("{:?}", event);
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
    let room = room_arc.read().await;
    let msg = match String::from_utf8(data.to_vec()) {
        Ok(text) => tokio_tungstenite::tungstenite::Message::Text(text.into()),
        Err(e) => tokio_tungstenite::tungstenite::Message::Binary(e.into_bytes().into()),
    };
    for (id, tx) in room.iter() {
        if id != sender_id {
            if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(msg.clone()) {
                warn!("slow consumer {}, dropping message", id);
            }
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
    let room = room_arc.read().await;
    let count = room.len();
    let presence = Message::new(
        MessageType::Presence,
        room_name.to_string(),
        Some(serde_json::json!({"room": room_name, "count": count}).to_string()),
    );
    let data = match serde_json::to_string(&presence) {
        Ok(d) => d,
        Err(_) => return,
    };
    let msg = tokio_tungstenite::tungstenite::Message::Text(data.into());
    for (id, tx) in room.iter() {
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
