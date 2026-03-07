import { processJob } from './worker.js';

const POLL_INTERVAL = 500;
const logger = {
  info: (msg, data) => console.log(JSON.stringify({ level: 'info', msg, ...data, time: new Date().toISOString() })),
  error: (msg, data) => console.log(JSON.stringify({ level: 'error', msg, ...data, time: new Date().toISOString() })),
};

export class WorkerManager {
  #queue;
  #running = false;
  #timer = null;
  #onResult = null;

  constructor(queue, { onResult } = {}) {
    this.#queue = queue;
    this.#onResult = onResult || null;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    logger.info('worker manager started');
    this.#poll();
  }

  stop() {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #poll() {
    while (this.#running) {
      let job;
      while ((job = this.#queue.dequeue())) {
        try {
          const result = await processJob(job);
          if (this.#onResult) this.#onResult(job, result);
        } catch (err) {
          logger.error('job failed', { jobId: job.id, attempt: job.attempts + 1, maxAttempts: job.maxAttempts, error: err.message });
          const requeued = this.#queue.requeue(job);
          if (requeued) {
            // Requeue with backoff metadata but don't block the poll loop —
            // other queued jobs can proceed while this one waits its turn.
            const delay = Math.min(1000 * Math.pow(2, job.attempts - 1), 30000);
            job._retryAfter = Date.now() + delay;
            logger.info('job requeued', { jobId: job.id, delay });
          } else {
            logger.error('job moved to dead-letter queue', { jobId: job.id, maxAttempts: job.maxAttempts });
          }
        }
      }
      await new Promise(resolve => {
        this.#timer = setTimeout(resolve, POLL_INTERVAL);
      });
    }
  }
}
