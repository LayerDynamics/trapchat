export async function processJob(job) {
  switch (job.type) {
    case 'media:chunk': {
      console.log(`processing media chunk: ${job.id}`);
      const { payload, chunkSize, roomId } = job.data || {};
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
      const result = chunks.map(c => ({ ...c, total, roomId }));
      console.log(`media:chunk ${job.id}: split into ${total} chunks`);
      return result;
    }

    case 'room:cleanup': {
      console.log(`processing room cleanup: ${job.id}`);
      const ALLOWED_GATEWAY_HOSTS = (process.env.ALLOWED_GATEWAY_HOSTS || 'localhost,127.0.0.1').split(',').map(h => h.trim());
      const { gatewayURL } = job.data || {};
      if (!gatewayURL) {
        throw new Error('room:cleanup requires gatewayURL');
      }
      const parsedGw = new URL(gatewayURL);
      if (!['http:', 'https:'].includes(parsedGw.protocol) || !ALLOWED_GATEWAY_HOSTS.includes(parsedGw.hostname)) {
        throw new Error(`disallowed gatewayURL host: ${parsedGw.hostname}`);
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
      console.log(`room:cleanup ${job.id}: checked ${rooms.length}, cleaned ${cleaned}`);
      return result;
    }

    default:
      console.warn(`unknown job type: ${job.type} (${job.id})`);
      throw new Error(`unknown job type: ${job.type}`);
  }
}
