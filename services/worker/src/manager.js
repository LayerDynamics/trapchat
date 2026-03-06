import { processJob } from './worker.js';

const POLL_INTERVAL = 500;

export class WorkerManager {
  #queue;
  #running = false;
  #timer = null;

  constructor(queue) {
    this.#queue = queue;
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
          await processJob(job);
        } catch (err) {
          console.error(`job ${job.id} failed:`, err.message);
        }
      }
      await new Promise(resolve => {
        this.#timer = setTimeout(resolve, POLL_INTERVAL);
      });
    }
  }
}
