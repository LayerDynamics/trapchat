import { randomUUID } from 'node:crypto';

const MAX_DEAD_LETTERS = 1000;

export class Queue {
  #items = [];
  #deadLetters = [];

  enqueue(type, data) {
    const id = randomUUID();
    this.#items.push({ id, type, data, createdAt: Date.now(), attempts: 0, maxAttempts: 3 });
    return id;
  }

  dequeue() {
    // Skip jobs still in retry backoff; find the first eligible one
    for (let i = 0; i < this.#items.length; i++) {
      if (!this.#items[i]._retryAfter || Date.now() >= this.#items[i]._retryAfter) {
        return this.#items.splice(i, 1)[0];
      }
    }
    return null;
  }

  size() {
    return this.#items.length;
  }

  peek() {
    return this.#items[0] || null;
  }

  requeue(job) {
    job.attempts++;
    if (job.attempts >= job.maxAttempts) {
      this.failed(job);
      return false;
    }
    this.#items.push(job);
    return true;
  }

  failed(job) {
    this.#deadLetters.push({ ...job, failedAt: Date.now() });
    // Evict oldest dead letters to prevent unbounded memory growth
    while (this.#deadLetters.length > MAX_DEAD_LETTERS) {
      this.#deadLetters.shift();
    }
  }

  deadLetters() {
    return [...this.#deadLetters];
  }
}
