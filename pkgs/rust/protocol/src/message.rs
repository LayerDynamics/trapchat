use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum MessageType {
    Join,
    Leave,
    Chat,
    Media,
    Presence,
    Error,
    Typing,
    Receipt,
    KeyRotation,
    Signal,
    Welcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    #[serde(default = "default_id")]
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: MessageType,
    pub room: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    pub timestamp: u64,
}

fn default_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_without_id_generates_uuid() {
        let json = r#"{"type":"chat","room":"test","payload":"hi","timestamp":123}"#;
        let msg: Message = serde_json::from_str(json).unwrap();
        assert!(!msg.id.is_empty());
        assert_eq!(msg.msg_type, MessageType::Chat);
        assert_eq!(msg.room, "test");
        assert_eq!(msg.payload, Some("hi".to_string()));
        assert_eq!(msg.timestamp, 123);
    }

    #[test]
    fn deserialize_with_id_preserves_it() {
        let json = r#"{"id":"custom-id","type":"join","room":"r1","timestamp":0}"#;
        let msg: Message = serde_json::from_str(json).unwrap();
        assert_eq!(msg.id, "custom-id");
    }

    #[test]
    fn serialize_roundtrip() {
        let msg = Message::new(MessageType::Chat, "room1".into(), Some("hello".into()));
        let json = serde_json::to_string(&msg).unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, msg.id);
        assert_eq!(back.msg_type, msg.msg_type);
        assert_eq!(back.room, msg.room);
        assert_eq!(back.payload, msg.payload);
    }

    #[test]
    fn deserialize_null_payload() {
        let json = r#"{"type":"join","room":"r1","timestamp":0}"#;
        let msg: Message = serde_json::from_str(json).unwrap();
        assert_eq!(msg.payload, None);
    }

    #[test]
    fn signal_roundtrip() {
        let msg = Message::new(MessageType::Signal, "room1".into(), Some(r#"{"signalType":"offer","data":{}}"#.into()));
        let json = serde_json::to_string(&msg).unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(back.msg_type, MessageType::Signal);
        assert_eq!(back.room, "room1");
        assert_eq!(back.payload, Some(r#"{"signalType":"offer","data":{}}"#.to_string()));
    }

    #[test]
    fn all_message_types_deserialize() {
        for t in ["join", "leave", "chat", "media", "presence", "error", "typing", "receipt", "key_rotation", "signal", "welcome"] {
            let json = format!(r#"{{"type":"{}","room":"r","timestamp":0}}"#, t);
            let msg: Message = serde_json::from_str(&json).unwrap();
            assert_eq!(msg.room, "r");
        }
    }

    #[test]
    fn invalid_type_fails() {
        let json = r#"{"type":"bogus","room":"r","timestamp":0}"#;
        assert!(serde_json::from_str::<Message>(json).is_err());
    }
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
