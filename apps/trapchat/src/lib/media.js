import { encryptBytes, decryptBytes } from './crypto.js';

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
    const encryptedChunk = await encryptBytes(key, chunkData);

    const payload = JSON.stringify({
      transferId,
      seq,
      total,
      mimeType,
      fileName: file.name,
      fileSize: file.size,
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

    const { transferId, seq, total, mimeType, fileName, fileSize, chunk } = meta;
    if (!transferId || seq === undefined || !total || !chunk) return null;

    // Bounds checks to prevent memory abuse
    if (total > MAX_CHUNKS || total <= 0) return null;
    if (seq < 0 || seq >= total) return null;

    if (!this.#transfers.has(transferId)) {
      if (this.#transfers.size >= MAX_CONCURRENT_TRANSFERS) return null;
      this.#transfers.set(transferId, {
        chunks: new Array(total),
        received: 0,
        total,
        mimeType,
        fileName: sanitizeFileName(fileName),
        fileSize,
      });
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

    let decrypted;
    try {
      decrypted = await decryptBytes(key, chunk);
    } catch {
      return { error: true, transferId, message: '[encrypted media — key mismatch]' };
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

      const blob = new Blob([assembled], { type: transfer.mimeType });
      const url = URL.createObjectURL(blob);

      return {
        complete: true,
        transferId,
        mimeType: transfer.mimeType,
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
