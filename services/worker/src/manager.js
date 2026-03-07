import { processJob } from './worker.js';

const POLL_INTERVAL = 500;

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
    console.log('worker manager started');
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
          console.error(`job ${job.id} failed (attempt ${job.attempts + 1}/${job.maxAttempts}):`, err.message);
          const requeued = this.#queue.requeue(job);
          if (requeued) {
            // Requeue with backoff metadata but don't block the poll loop —
            // other queued jobs can proceed while this one waits its turn.
            const delay = Math.min(1000 * Math.pow(2, job.attempts - 1), 30000);
            job._retryAfter = Date.now() + delay;
            console.log(`job ${job.id} requeued, eligible after ${delay}ms`);
          } else {
            console.error(`job ${job.id} moved to dead-letter queue after ${job.maxAttempts} attempts`);
          }
        }
      }
      await new Promise(resolve => {
        this.#timer = setTimeout(resolve, POLL_INTERVAL);
      });
    }
  }
}
