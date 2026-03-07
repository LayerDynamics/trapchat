use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
#[non_exhaustive]
pub enum RoomEvent {
    Created { room: String },
    Joined { room: String, peer_count: usize },
    Left { room: String, peer_count: usize },
    Destroyed { room: String },
}
