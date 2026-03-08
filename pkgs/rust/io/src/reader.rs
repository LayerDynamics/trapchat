use tokio::io::AsyncReadExt;
use tracing::{debug, warn};

use crate::error::IoError;
use crate::frame::{Frame, MAX_FRAME_SIZE};

/// Async frame reader that reads frames from a tokio AsyncRead source.
pub struct FrameReader<R> {
    reader: R,
    buf: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buf: Vec::with_capacity(4096),
        }
    }

    /// Read the next frame from the underlying reader.
    pub async fn read_frame(&mut self) -> Result<Frame, IoError> {
        // Read header (1 byte type + 4 bytes length)
        let mut header = [0u8; 5];
        self.reader.read_exact(&mut header).await?;

        let frame_type = header[0];
        if frame_type == 0 {
            warn!("invalid frame type: {}", frame_type);
            return Err(IoError::InvalidFrameType(frame_type));
        }
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;

        debug!("reading frame type={} length={}", frame_type, length);

        if length > MAX_FRAME_SIZE {
            warn!("frame too large: {} bytes", length);
            return Err(IoError::FrameTooLarge {
                size: length,
                max: MAX_FRAME_SIZE,
            });
        }

        self.buf.resize(length, 0);
        self.reader.read_exact(&mut self.buf[..length]).await?;

        let payload = self.buf[..length].to_vec();

        // Shrink buffer back if a large frame inflated it beyond the default
        const SHRINK_THRESHOLD: usize = 64 * 1024;
        if self.buf.capacity() > SHRINK_THRESHOLD && length <= 4096 {
            self.buf = Vec::with_capacity(4096);
        }

        Ok(Frame::new(frame_type, payload))
    }

    /// Maximum number of frames `read_all` will collect before stopping.
    const MAX_READ_ALL_FRAMES: usize = 10_000;

    /// Read all available frames into a Vec, consuming the reader.
    /// Stops after `MAX_READ_ALL_FRAMES` to prevent unbounded memory growth.
    pub async fn read_all(mut self) -> Vec<Result<Frame, IoError>> {
        let mut frames = Vec::new();
        loop {
            if frames.len() >= Self::MAX_READ_ALL_FRAMES {
                warn!("read_all hit frame limit ({}), stopping", Self::MAX_READ_ALL_FRAMES);
                break;
            }
            match self.read_frame().await {
                Ok(frame) => frames.push(Ok(frame)),
                Err(IoError::Io(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => {
                    frames.push(Err(e));
                    break;
                }
            }
        }
        frames
    }
}

/// Create a stream of frames from a tokio AsyncRead source.
/// Uses futures_util::stream::unfold for clean async iteration.
pub fn frame_stream<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
) -> impl futures_util::Stream<Item = Result<Frame, IoError>> {
    futures_util::stream::unfold(FrameReader::new(reader), |mut reader| async move {
        match reader.read_frame().await {
            Ok(frame) => Some((Ok(frame), reader)),
            Err(IoError::Io(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => None,
            Err(e) => Some((Err(e), reader)),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[tokio::test]
    async fn read_frame_roundtrip() {
        let frame = Frame::new(1, b"test payload".to_vec());
        let encoded = frame.encode().unwrap();
        let cursor = std::io::Cursor::new(encoded);
        let mut reader = FrameReader::new(cursor);
        let decoded = reader.read_frame().await.unwrap();
        assert_eq!(decoded, frame);
    }

    #[tokio::test]
    async fn frame_stream_reads_multiple() {
        use std::pin::pin;
        let f1 = Frame::new(1, b"hello".to_vec());
        let f2 = Frame::new(2, b"world".to_vec());
        let mut data = f1.encode().unwrap();
        data.extend_from_slice(&f2.encode().unwrap());

        let cursor = std::io::Cursor::new(data);
        let mut stream = pin!(frame_stream(cursor));

        let r1 = stream.next().await.unwrap().unwrap();
        assert_eq!(r1, f1);
        let r2 = stream.next().await.unwrap().unwrap();
        assert_eq!(r2, f2);
    }

    #[tokio::test]
    async fn read_all_collects_frames() {
        let f1 = Frame::new(1, b"a".to_vec());
        let f2 = Frame::new(2, b"b".to_vec());
        let mut data = f1.encode().unwrap();
        data.extend_from_slice(&f2.encode().unwrap());

        let cursor = std::io::Cursor::new(data);
        let reader = FrameReader::new(cursor);
        let results = reader.read_all().await;
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_ref().unwrap(), &f1);
        assert_eq!(results[1].as_ref().unwrap(), &f2);
    }
}
