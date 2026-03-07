use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("invalid message type: {0}")]
    InvalidMessageType(String),

    #[error("missing required field: {0}")]
    MissingField(&'static str),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}
