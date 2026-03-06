import { randomUUID } from 'node:crypto';

export class Queue {
  #items = [];

  enqueue(type, data) {
    const id = randomUUID();
    this.#items.push({ id, type, data, createdAt: Date.now() });
    return id;
  }

  dequeue() {
    return this.#items.shift() || null;
  }

  size() {
    return this.#items.length;
  }

  peek() {
    return this.#items[0] || null;
  }
}
