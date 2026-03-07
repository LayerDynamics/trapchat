import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processJob } from './worker.js';

describe('processJob', () => {
  describe('media:chunk', () => {
    it('splits payload into correct number of chunks', async () => {
      // 10 bytes, chunk size 4 → 3 chunks
      const payload = Buffer.from('0123456789').toString('base64');
      const job = { id: 'j1', type: 'media:chunk', data: { payload, chunkSize: 4, roomId: 'r1' } };
      const result = await processJob(job);
      assert.equal(result.length, 3);
      assert.equal(result[0].seq, 0);
      assert.equal(result[0].total, 3);
      assert.equal(result[0].roomId, 'r1');
    });

    it('handles single chunk', async () => {
      const payload = Buffer.from('hi').toString('base64');
      const job = { id: 'j2', type: 'media:chunk', data: { payload, chunkSize: 100 } };
      const result = await processJob(job);
      assert.equal(result.length, 1);
      assert.equal(result[0].seq, 0);
      assert.equal(result[0].total, 1);
    });

    it('throws without payload', async () => {
      const job = { id: 'j3', type: 'media:chunk', data: { chunkSize: 4 } };
      await assert.rejects(() => processJob(job), /payload and chunkSize/);
    });

    it('throws without chunkSize', async () => {
      const payload = Buffer.from('data').toString('base64');
      const job = { id: 'j4', type: 'media:chunk', data: { payload } };
      await assert.rejects(() => processJob(job), /payload and chunkSize/);
    });

    it('reconstructs original data from chunks', async () => {
      const original = 'hello world test data';
      const payload = Buffer.from(original).toString('base64');
      const job = { id: 'j5', type: 'media:chunk', data: { payload, chunkSize: 7 } };
      const result = await processJob(job);
      const reconstructed = Buffer.concat(
        result.map(c => Buffer.from(c.data, 'base64'))
      ).toString();
      assert.equal(reconstructed, original);
    });
  });

  describe('room:cleanup', () => {
    it('blocks disallowed gateway hosts (SSRF)', async () => {
      const job = { id: 'j-ssrf', type: 'room:cleanup', data: { gatewayURL: 'http://evil.com:8080' } };
      await assert.rejects(() => processJob(job), /disallowed gatewayURL host/);
    });

    it('blocks non-http protocols', async () => {
      const job = { id: 'j-proto', type: 'room:cleanup', data: { gatewayURL: 'file:///etc/passwd' } };
      await assert.rejects(() => processJob(job), /disallowed gatewayURL host/);
    });

    it('requires gatewayURL', async () => {
      const job = { id: 'j-no-url', type: 'room:cleanup', data: {} };
      await assert.rejects(() => processJob(job), /gatewayURL/);
    });
  });

  describe('unknown job type', () => {
    it('throws for unknown type', async () => {
      const job = { id: 'j6', type: 'bogus', data: {} };
      await assert.rejects(() => processJob(job), /unknown job type: bogus/);
    });
  });
});
