use crate::IoError;

const MAX_FRAME_SIZE: usize = 1024 * 1024; // 1 MB

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
    pub fn encode(&self) -> Vec<u8> {
        let len = self.payload.len() as u32;
        let mut buf = Vec::with_capacity(5 + self.payload.len());
        buf.push(self.frame_type);
        buf.extend_from_slice(&len.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        buf
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
        let encoded = frame.encode();
        let (decoded, consumed) = Frame::decode(&encoded).unwrap();
        assert_eq!(frame, decoded);
        assert_eq!(consumed, encoded.len());
    }
}
