use crate::IoError;

pub const MAX_FRAME_SIZE: usize = 1024 * 1024; // 1 MB

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub frame_type: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(frame_type: u8, payload: Vec<u8>) -> Self {
        Self { frame_type, payload }
    }

    /// Encode frame: [type:1][length:4 BE][payload:N]
    ///
    /// Returns an error if the payload exceeds MAX_FRAME_SIZE, preventing
    /// silent truncation of the u32 length field for payloads > 4GB.
    pub fn encode(&self) -> Result<Vec<u8>, IoError> {
        if self.payload.len() > MAX_FRAME_SIZE {
            return Err(IoError::FrameTooLarge {
                size: self.payload.len(),
                max: MAX_FRAME_SIZE,
            });
        }
        let len = self.payload.len() as u32;
        let mut buf = Vec::with_capacity(5 + self.payload.len());
        buf.push(self.frame_type);
        buf.extend_from_slice(&len.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        Ok(buf)
    }

    /// Decode frame from bytes. Returns (Frame, bytes_consumed).
    pub fn decode(data: &[u8]) -> Result<(Self, usize), IoError> {
        if data.len() < 5 {
            return Err(IoError::IncompleteFrame {
                expected: 5,
                got: data.len(),
            });
        }

        let frame_type = data[0];
        if frame_type == 0 {
            return Err(IoError::InvalidFrameType(frame_type));
        }
        let length = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;

        if length > MAX_FRAME_SIZE {
            return Err(IoError::FrameTooLarge {
                size: length,
                max: MAX_FRAME_SIZE,
            });
        }

        let total = 5 + length;
        if data.len() < total {
            return Err(IoError::IncompleteFrame {
                expected: total,
                got: data.len(),
            });
        }

        let payload = data[5..total].to_vec();
        Ok((Self { frame_type, payload }, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let frame = Frame::new(1, b"hello".to_vec());
        let encoded = frame.encode().unwrap();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(frame, decoded);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn encode_rejects_oversized_payload() {
        let frame = Frame::new(1, vec![0u8; MAX_FRAME_SIZE + 1]);
        assert!(frame.encode().is_err());
    }
}
