import { createServer } from 'node:http';
import { Queue } from './queue.js';
import { WorkerManager } from './manager.js';

const PORT = process.env.WORKER_PORT || 9100;

const queue = new Queue();
const manager = new WorkerManager(queue);

const server = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'worker', queued: queue.size() }));
    return;
  }

  if (req.url === '/jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const job = JSON.parse(body);
        const id = queue.enqueue(job.type, job.data);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`worker listening on :${PORT}`);
  manager.start();
});
