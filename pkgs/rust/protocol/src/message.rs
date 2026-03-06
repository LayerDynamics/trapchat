use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Join,
    Leave,
    Chat,
    Media,
    Presence,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: MessageType,
    pub room: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    pub timestamp: u64,
}

impl Message {
    pub fn new(msg_type: MessageType, room: String, payload: Option<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            msg_type,
            room,
            payload,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
}
