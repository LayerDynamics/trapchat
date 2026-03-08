import { encrypt, decrypt, encryptBytes, decryptBytes, encryptMediaEnvelope, decryptMediaEnvelope } from './crypto.js';

const CHUNK_SIZE = 512 * 1024; // 512KB raw
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const STALE_TIMEOUT = 30000; // 30s per chunk (reset on each received chunk)
const SEND_THROTTLE_MS = 50; // Delay between chunks to avoid flooding relay
const MAX_CHUNKS = 100; // Max chunks per transfer (prevents memory abuse)
const MAX_CONCURRENT_TRANSFERS = 10; // Max simultaneous incoming transfers

const MAGIC_BYTES = {
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/gif': [0x47, 0x49, 0x46],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'video/mp4': null, // ftyp at offset 4
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return 'file';
  // Strip path separators, null bytes, and collapse '..' to prevent path traversal
  return name.replace(/\.\./g, '').replace(/[/\\:\0]/g, '_').slice(0, 255) || 'file';
}

function detectMimeType(file, bytes) {
  if (file.type) return file.type;

  // Magic byte fallback
  for (const [mime, sig] of Object.entries(MAGIC_BYTES)) {
    if (!sig) continue;
    if (sig.every((b, i) => bytes[i] === b)) return mime;
  }

  // MP4: check for 'ftyp' at offset 4
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'video/mp4';
  }

  return 'application/octet-stream';
}

/**
 * Validate a claimed MIME type against the actual file bytes.
 * If the claimed type doesn't match the magic bytes, fall back to detected type.
 */
function validateMimeType(claimedMime, bytes) {
  if (!claimedMime || bytes.length < 8) return 'application/octet-stream';

  // Detect actual type from magic bytes
  for (const [mime, sig] of Object.entries(MAGIC_BYTES)) {
    if (!sig) continue;
    if (sig.every((b, i) => bytes[i] === b)) {
      // If claimed type matches a known type but magic bytes say otherwise, use detected
      return claimedMime === mime ? claimedMime : mime;
    }
  }

  // MP4 check
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'video/mp4';
  }

  // No magic bytes matched — trust claimed type only for formats that lack magic bytes
  const SAFE_NO_MAGIC = [
    'text/', 'application/json', 'application/xml', 'image/svg+xml',
    'application/javascript', 'application/x-yaml', 'application/toml',
  ];
  if (SAFE_NO_MAGIC.some(prefix => claimedMime.startsWith(prefix))) {
    return claimedMime;
  }

  // Claimed a binary type (image/png, etc.) but magic bytes didn't match — reject
  return 'application/octet-stream';
}

export async function sendMedia(client, key, room, file, onProgress) {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max is 25MB.`);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const mimeType = detectMimeType(file, bytes);
  const transferId = crypto.randomUUID();
  const total = Math.ceil(bytes.length / CHUNK_SIZE);

  for (let seq = 0; seq < total; seq++) {
    const start = seq * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, bytes.length);
    const chunkData = bytes.slice(start, end);
    // Only embed metadata in chunk 0 to avoid redundant encryption overhead
    const metadata = seq === 0 ? { mimeType, fileName: file.name, fileSize: file.size } : {};
    const encryptedChunk = await encryptMediaEnvelope(key, chunkData, metadata);

    const payload = JSON.stringify({
      transferId,
      seq,
      total,
      chunk: encryptedChunk,
    });

    client.send('media', room, payload);

    if (onProgress) {
      onProgress(seq + 1, total);
    }

    // Throttle sending to avoid flooding the relay with back-to-back chunks
    if (seq < total - 1) {
      await new Promise(r => setTimeout(r, SEND_THROTTLE_MS));
    }
  }

  return { transferId, total, mimeType, fileName: file.name };
}

/**
 * Send a canvas snapshot (PNG) to all peers in a room.
 * @param {TrapChatClient} client
 * @param {CryptoKey} key
 * @param {string} room
 * @param {HTMLCanvasElement} canvas
 * @param {function} [onProgress]
 */
export async function sendCanvas(client, key, room, canvas, onProgress) {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas toBlob failed')), 'image/png');
  });
  const file = new File([blob], `canvas-${Date.now()}.png`, { type: 'image/png' });
  return sendMedia(client, key, room, file, onProgress);
}

export class MediaAssembler {
  #transfers = new Map();
  #timers = new Map();
  #onProgress = null;

  /**
   * @param {object} [opts]
   * @param {function} [opts.onProgress] - Called with (transferId, received, total) for download progress
   */
  constructor(opts) {
    this.#onProgress = opts?.onProgress || null;
  }

  async handleChunk(data, key) {
    let meta;
    try {
      meta = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
    } catch {
      return null;
    }

    const { transferId, seq, total, chunk } = meta;
    if (!transferId || seq === undefined || !total || !chunk) return null;

    // Bounds checks to prevent memory abuse
    if (total > MAX_CHUNKS || total <= 0) return null;
    if (seq < 0 || seq >= total) return null;

    // Decrypt the inner envelope to get data + metadata
    let inner;
    try {
      const decryptedJson = await decrypt(key, chunk);
      inner = JSON.parse(decryptedJson);
    } catch {
      return { error: true, transferId, message: '[encrypted media — key mismatch]' };
    }

    if (!this.#transfers.has(transferId)) {
      if (this.#transfers.size >= MAX_CONCURRENT_TRANSFERS) return null;
      this.#transfers.set(transferId, {
        chunks: new Array(total),
        received: 0,
        total,
        mimeType: null,
        fileName: null,
        fileSize: null,
      });
    } else if (seq === 0 && inner.mimeType) {
      // First chunk arrived out of order — update metadata
      const transfer = this.#transfers.get(transferId);
      transfer.mimeType = inner.mimeType;
      transfer.fileName = sanitizeFileName(inner.fileName);
      transfer.fileSize = inner.fileSize;
    }

    // Reset stale timeout on each chunk so large transfers on slow connections don't expire
    if (this.#timers.has(transferId)) {
      clearTimeout(this.#timers.get(transferId));
    }
    const timer = setTimeout(() => {
      this.#transfers.delete(transferId);
      this.#timers.delete(transferId);
    }, STALE_TIMEOUT);
    this.#timers.set(transferId, timer);

    const transfer = this.#transfers.get(transferId);
    if (transfer.chunks[seq]) return null; // duplicate

    // Decrypt the actual file data bytes from the inner envelope
    let decrypted;
    let chunkMeta;
    try {
      const result = await decryptMediaEnvelope(key, chunk);
      decrypted = result.chunkData;
      chunkMeta = result.metadata;
    } catch {
      return { error: true, transferId, message: '[encrypted media — key mismatch]' };
    }

    // Store metadata from the first chunk that contains it (handles out-of-order delivery)
    if (transfer.mimeType === null && chunkMeta.mimeType) {
      transfer.mimeType = chunkMeta.mimeType;
      transfer.fileName = sanitizeFileName(chunkMeta.fileName);
      transfer.fileSize = chunkMeta.fileSize;
    }

    transfer.chunks[seq] = decrypted;
    transfer.received++;

    if (this.#onProgress) {
      this.#onProgress(transferId, transfer.received, transfer.total);
    }

    if (transfer.received === transfer.total) {
      // Reassemble
      const totalSize = transfer.chunks.reduce((sum, c) => sum + c.length, 0);

      // Enforce file size limit on reassembled data (sender's fileSize field is untrusted)
      if (totalSize > MAX_FILE_SIZE) {
        clearTimeout(this.#timers.get(transferId));
        this.#timers.delete(transferId);
        this.#transfers.delete(transferId);
        return { error: true, transferId, message: `[media rejected — exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit]` };
      }

      const assembled = new Uint8Array(totalSize);
      let offset = 0;
      for (const c of transfer.chunks) {
        assembled.set(c, offset);
        offset += c.length;
      }

      // Cleanup
      clearTimeout(this.#timers.get(transferId));
      this.#timers.delete(transferId);
      this.#transfers.delete(transferId);

      // Validate claimed MIME type against actual file content (magic bytes)
      const validatedMime = validateMimeType(transfer.mimeType, assembled);

      const blob = new Blob([assembled], { type: validatedMime });
      const url = URL.createObjectURL(blob);

      return {
        complete: true,
        transferId,
        mimeType: validatedMime,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        url,
        blob,
      };
    }

    return { progress: true, transferId, received: transfer.received, total: transfer.total };
  }

  destroy() {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#transfers.clear();
  }
}
