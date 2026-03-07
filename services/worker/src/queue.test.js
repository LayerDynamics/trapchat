import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from './queue.js';

describe('Queue', () => {
  let q;

  beforeEach(() => {
    q = new Queue();
  });

  it('enqueue returns a UUID and increases size', () => {
    const id = q.enqueue('test', { foo: 1 });
    assert.ok(id, 'should return an id');
    assert.equal(q.size(), 1);
  });

  it('dequeue returns jobs in FIFO order', () => {
    q.enqueue('first', {});
    q.enqueue('second', {});
    const job1 = q.dequeue();
    const job2 = q.dequeue();
    assert.equal(job1.type, 'first');
    assert.equal(job2.type, 'second');
    assert.equal(q.size(), 0);
  });

  it('dequeue returns null when empty', () => {
    assert.equal(q.dequeue(), null);
  });

  it('peek returns first item without removing', () => {
    q.enqueue('test', {});
    const peeked = q.peek();
    assert.equal(peeked.type, 'test');
    assert.equal(q.size(), 1);
  });

  it('peek returns null when empty', () => {
    assert.equal(q.peek(), null);
  });

  it('requeue increments attempts and re-adds job', () => {
    q.enqueue('test', {});
    const job = q.dequeue();
    assert.equal(job.attempts, 0);
    const requeued = q.requeue(job);
    assert.equal(requeued, true);
    assert.equal(job.attempts, 1);
    assert.equal(q.size(), 1);
  });

  it('requeue moves to dead-letter after maxAttempts', () => {
    q.enqueue('test', {});
    const job = q.dequeue();
    job.attempts = job.maxAttempts - 1; // one away from max
    const requeued = q.requeue(job);
    assert.equal(requeued, false);
    assert.equal(q.size(), 0);
    assert.equal(q.deadLetters().length, 1);
    assert.equal(q.deadLetters()[0].type, 'test');
  });

  it('deadLetters returns a copy', () => {
    q.enqueue('test', {});
    const job = q.dequeue();
    job.attempts = job.maxAttempts - 1;
    q.requeue(job);
    const dl = q.deadLetters();
    dl.pop();
    assert.equal(q.deadLetters().length, 1, 'original should be unaffected');
  });

  it('dequeue skips jobs in retry backoff', () => {
    q.enqueue('backoff', {});
    q.enqueue('ready', {});
    const job = q.dequeue();
    job._retryAfter = Date.now() + 60000; // far future
    job.attempts = 0;
    q.requeue(job);
    // Now queue has [backoff (in backoff), ready]
    const next = q.dequeue();
    assert.equal(next.type, 'ready');
  });

  it('caps dead letters at 1000', () => {
    for (let i = 0; i < 1010; i++) {
      q.enqueue('task', {});
      const job = q.dequeue();
      job.attempts = job.maxAttempts - 1;
      q.requeue(job);
    }
    assert.ok(q.deadLetters().length <= 1000);
  });

  it('jobs created with correct defaults', () => {
    q.enqueue('test', { key: 'val' });
    const job = q.dequeue();
    assert.equal(job.type, 'test');
    assert.deepEqual(job.data, { key: 'val' });
    assert.equal(job.attempts, 0);
    assert.equal(job.maxAttempts, 3);
    assert.ok(job.createdAt > 0);
    assert.ok(job.id);
  });
});
