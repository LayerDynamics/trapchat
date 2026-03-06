use thiserror::Error;

#[derive(Debug, Error)]
pub enum IoError {
    #[error("frame too large: {size} bytes (max {max})")]
    FrameTooLarge { size: usize, max: usize },

    #[error("incomplete frame: expected {expected} bytes, got {got}")]
    IncompleteFrame { expected: usize, got: usize },

    #[error("invalid frame type: {0}")]
    InvalidFrameType(u8),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
