import { logger } from './logger.js';

const FETCH_TIMEOUT = 15_000;
const ALLOWED_GATEWAY_HOSTS = (process.env.ALLOWED_GATEWAY_HOSTS || 'localhost,127.0.0.1').split(',').map(h => h.trim());
const ALLOWED_PORTS = ['80', '443', '8080'];

/**
 * Validates a gateway URL against SSRF allowlist. Throws on invalid URL.
 * @returns {URL} the parsed URL
 */
function validateGatewayURL(gatewayURL) {
  if (!gatewayURL) throw new Error('gatewayURL is required');
  const parsed = new URL(gatewayURL);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  if (!['http:', 'https:'].includes(parsed.protocol) || !ALLOWED_GATEWAY_HOSTS.includes(parsed.hostname) || !ALLOWED_PORTS.includes(port)) {
    throw new Error(`disallowed gatewayURL host or port: ${parsed.host}`);
  }
  return parsed;
}

export async function processJob(job) {
  switch (job.type) {
    case 'media:chunk': {
      logger.info('processing media chunk', { jobId: job.id });
      const { payload, chunkSize, roomId, gatewayURL, transferId, mimeType, fileName, fileSize } = job.data || {};
      if (!payload || typeof chunkSize !== 'number' || chunkSize <= 0) {
        throw new Error('media:chunk requires payload and positive chunkSize');
      }
      const rawBytes = Buffer.from(payload, 'base64');
      const chunks = [];
      for (let i = 0; i < rawBytes.length; i += chunkSize) {
        chunks.push({
          seq: chunks.length,
          data: rawBytes.subarray(i, i + chunkSize).toString('base64'),
        });
      }
      const total = chunks.length;
      const result = chunks.map(c => ({ ...c, total, roomId, transferId, mimeType, fileName, fileSize }));
      logger.info('media:chunk split', { jobId: job.id, total });

      // Forward chunked results back to the gateway for room delivery
      if (gatewayURL && roomId) {
        validateGatewayURL(gatewayURL);
        for (const chunk of result) {
          try {
            await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(roomId)}/broadcast`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'media',
                payload: JSON.stringify({
                  transferId: transferId || job.id,
                  seq: chunk.seq,
                  total: chunk.total,
                  mimeType,
                  fileName,
                  fileSize,
                  chunk: chunk.data,
                }),
              }),
              signal: AbortSignal.timeout(FETCH_TIMEOUT),
            });
          } catch (err) {
            logger.error('media:chunk forward failed', { jobId: job.id, seq: chunk.seq, error: err.message });
          }
        }
      }

      return result;
    }

    case 'room:cleanup': {
      logger.info('processing room cleanup', { jobId: job.id });
      const { gatewayURL } = job.data || {};
      validateGatewayURL(gatewayURL);

      // Fetch room list
      const roomsRes = await fetch(`${gatewayURL}/api/rooms`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!roomsRes.ok) throw new Error(`failed to fetch rooms: ${roomsRes.status}`);
      const { rooms } = await roomsRes.json();

      const defaultStaleThreshold = 30 * 60 * 1000; // 30 minutes
      const CONCURRENCY = 10;

      // Check each room for staleness — returns true if it should be cleaned
      async function shouldCleanRoom(room) {
        try {
          const infoRes = await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(room.name)}/info`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
          if (!infoRes.ok) return false;
          const info = await infoRes.json();

          // Check per-room TTL first
          try {
            const ttlRes = await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(room.name)}/ttl`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
            if (ttlRes.ok) {
              const ttlData = await ttlRes.json();
              if (ttlData.ttlSeconds > 0 && ttlData.expiresAt > 0 && Date.now() > ttlData.expiresAt) {
                return true;
              }
            }
          } catch {
            // TTL endpoint unavailable, fall through to default
          }

          const idle = Date.now() - new Date(info.lastActivity).getTime();
          return info.peers === 0 && idle > defaultStaleThreshold;
        } catch {
          return false;
        }
      }

      // Process rooms in parallel batches
      let cleaned = 0;
      for (let i = 0; i < rooms.length; i += CONCURRENCY) {
        const batch = rooms.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (room) => {
          if (await shouldCleanRoom(room)) {
            const cleanRes = await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(room.name)}/cleanup`, { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
            return cleanRes.ok;
          }
          return false;
        }));
        cleaned += results.filter(r => r.status === 'fulfilled' && r.value).length;
      }

      const result = { checked: rooms.length, cleaned };
      logger.info('room:cleanup complete', { jobId: job.id, checked: rooms.length, cleaned });
      return result;
    }

    default:
      logger.warn('unknown job type', { type: job.type, jobId: job.id });
      throw new Error(`unknown job type: ${job.type}`);
  }
}
