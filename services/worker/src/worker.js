const logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data, time: new Date().toISOString() })),
  warn: (msg, data) => console.log(JSON.stringify({ level: 'warn', msg, ...data, time: new Date().toISOString() })),
  error: (msg, data) => console.log(JSON.stringify({ level: 'error', msg, ...data, time: new Date().toISOString() })),
};

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
        const ALLOWED_GATEWAY_HOSTS = (process.env.ALLOWED_GATEWAY_HOSTS || 'localhost,127.0.0.1').split(',').map(h => h.trim());
        const parsedGw = new URL(gatewayURL);
        const gwPort = parsedGw.port || (parsedGw.protocol === 'https:' ? '443' : '80');
        if (['http:', 'https:'].includes(parsedGw.protocol) && ALLOWED_GATEWAY_HOSTS.includes(parsedGw.hostname) && ['80', '443', '8080'].includes(gwPort)) {
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
                signal: AbortSignal.timeout(15_000),
              });
            } catch (err) {
              logger.error('media:chunk forward failed', { jobId: job.id, seq: chunk.seq, error: err.message });
            }
          }
        }
      }

      return result;
    }

    case 'room:cleanup': {
      logger.info('processing room cleanup', { jobId: job.id });
      const ALLOWED_GATEWAY_HOSTS = (process.env.ALLOWED_GATEWAY_HOSTS || 'localhost,127.0.0.1').split(',').map(h => h.trim());
      const { gatewayURL } = job.data || {};
      if (!gatewayURL) {
        throw new Error('room:cleanup requires gatewayURL');
      }
      const parsedGw = new URL(gatewayURL);
      const gwPort = parsedGw.port || (parsedGw.protocol === 'https:' ? '443' : '80');
      if (!['http:', 'https:'].includes(parsedGw.protocol) || !ALLOWED_GATEWAY_HOSTS.includes(parsedGw.hostname) || !['80', '443', '8080'].includes(gwPort)) {
        throw new Error(`disallowed gatewayURL host or port: ${parsedGw.host}`);
      }

      const FETCH_TIMEOUT = 15_000; // 15s timeout for all outbound requests

      // Fetch room list
      const roomsRes = await fetch(`${gatewayURL}/api/rooms`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (!roomsRes.ok) throw new Error(`failed to fetch rooms: ${roomsRes.status}`);
      const { rooms } = await roomsRes.json();

      let cleaned = 0;
      const staleThreshold = 30 * 60 * 1000; // 30 minutes

      for (const room of rooms) {
        const infoRes = await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(room.name)}/info`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
        if (!infoRes.ok) continue;
        const info = await infoRes.json();

        const idle = Date.now() - new Date(info.lastActivity).getTime();
        if (info.peers === 0 && idle > staleThreshold) {
          const cleanRes = await fetch(`${gatewayURL}/api/rooms/${encodeURIComponent(room.name)}/cleanup`, { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
          if (cleanRes.ok) cleaned++;
        }
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
