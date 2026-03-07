import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Queue } from './queue.js';
import { WorkerManager } from './manager.js';

const PORT = process.env.WORKER_PORT || 9100;
const MAX_RESULTS = 1000;
const MAX_SUBMITTED_JOBS = 10000;
const AUTH_TOKEN = process.env.WORKER_AUTH_TOKEN || '';

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true; // no auth configured — dev mode
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const tokenBuf = Buffer.from(token);
  const authBuf = Buffer.from(AUTH_TOKEN);
  if (!token || tokenBuf.length !== authBuf.length) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  if (!timingSafeEqual(tokenBuf, authBuf)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  return true;
}

const queue = new Queue();
const results = new Map();

function trackResult(job, result) {
  results.set(job.id, { id: job.id, status: 'completed', result, completedAt: Date.now() });
  // Evict oldest if over limit
  if (results.size > MAX_RESULTS) {
    const oldest = results.keys().next().value;
    results.delete(oldest);
  }
  // Fire callback if provided (restricted to allowed hosts to prevent SSRF)
  if (job.data?.callbackURL) {
    const ALLOWED_CALLBACK_HOSTS = (process.env.ALLOWED_CALLBACK_HOSTS || 'localhost,127.0.0.1').split(',').map(h => h.trim());
    try {
      const cbUrl = new URL(job.data.callbackURL);
      if (!['http:', 'https:'].includes(cbUrl.protocol)) {
        throw new Error(`disallowed protocol: ${cbUrl.protocol}`);
      }
      if (!ALLOWED_CALLBACK_HOSTS.includes(cbUrl.hostname) || (cbUrl.port && !['80', '443'].includes(cbUrl.port))) {
        throw new Error(`disallowed callback host or port: ${cbUrl.host}`);
      }
      fetch(job.data.callbackURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, status: 'completed', result }),
      }).catch(err => console.error(`callback failed for ${job.id}:`, err.message));
    } catch (err) {
      console.error(`callback URL rejected for ${job.id}: ${err.message}`);
    }
  }
}

const manager = new WorkerManager(queue, { onResult: trackResult });

// Track submitted job IDs for status lookup
const submittedJobs = new Set();

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'worker', queued: queue.size() }));
    return;
  }

  if (!checkAuth(req, res)) return;

  if (url.pathname === '/jobs' && req.method === 'POST') {
    const MAX_BODY = 1024 * 1024; // 1MB
    let body = '';
    let overflow = false;
    req.on('data', chunk => {
      if (body.length + chunk.length > MAX_BODY) {
        overflow = true;
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (overflow) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        return;
      }
      try {
        const job = JSON.parse(body);
        if (typeof job.type !== 'string' || !job.type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'type must be a non-empty string' }));
          return;
        }
        if (job.data !== undefined && (typeof job.data !== 'object' || job.data === null || Array.isArray(job.data))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'data must be an object' }));
          return;
        }
        const id = queue.enqueue(job.type, job.data);
        submittedJobs.add(id);
        // Evict oldest submitted job IDs to prevent unbounded growth
        if (submittedJobs.size > MAX_SUBMITTED_JOBS) {
          const oldest = submittedJobs.values().next().value;
          submittedJobs.delete(oldest);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  // GET /jobs/:id — job status
  const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'GET') {
    const id = jobMatch[1];
    if (results.has(id)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results.get(id)));
    } else if (submittedJobs.has(id)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, status: 'pending' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job not found' }));
    }
    return;
  }

  if (url.pathname === '/dead-letters' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deadLetters: queue.deadLetters() }));
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`worker listening on :${PORT}`);
  if (!AUTH_TOKEN) {
    console.warn('WARNING: WORKER_AUTH_TOKEN not set — running without authentication');
  }
  manager.start();
});

// Graceful shutdown — stop accepting jobs, drain in-flight work, then exit
function shutdown(signal) {
  console.log(`received ${signal}, shutting down gracefully...`);
  manager.stop();
  server.close(() => {
    console.log('worker stopped');
    process.exit(0);
  });
  // Force exit after 10s if drain doesn't complete
  setTimeout(() => {
    console.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
