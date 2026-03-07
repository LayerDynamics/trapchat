import { describe, it, expect, vi } from 'vitest'
import { MediaAssembler } from '../media.js'
import { generateRoomKey, encryptBytes } from '../crypto.js'

describe('MediaAssembler', () => {
  async function makeChunk(key, transferId, seq, total, data) {
    const chunk = await encryptBytes(key, data)
    return {
      type: 'media',
      payload: JSON.stringify({
        transferId,
        seq,
        total,
        mimeType: 'application/octet-stream',
        fileName: 'test.bin',
        fileSize: data.length,
        chunk,
      }),
    }
  }

  it('assembles a single-chunk transfer', async () => {
    const key = await generateRoomKey()
    const assembler = new MediaAssembler()
    const data = new Uint8Array([1, 2, 3])
    const chunk = await makeChunk(key, 'tx1', 0, 1, data)
    const result = await assembler.handleChunk(chunk, key)
    expect(result.complete).toBe(true)
    expect(result.fileName).toBe('test.bin')
    assembler.destroy()
  })

  it('assembles multi-chunk transfer in order', async () => {
    const key = await generateRoomKey()
    const onProgress = vi.fn()
    const assembler = new MediaAssembler({ onProgress })

    const part1 = new Uint8Array([1, 2])
    const part2 = new Uint8Array([3, 4])
    const chunk0 = await makeChunk(key, 'tx2', 0, 2, part1)
    const chunk1 = await makeChunk(key, 'tx2', 1, 2, part2)

    const r0 = await assembler.handleChunk(chunk0, key)
    expect(r0.progress).toBe(true)
    expect(onProgress).toHaveBeenCalledWith('tx2', 1, 2)

    const r1 = await assembler.handleChunk(chunk1, key)
    expect(r1.complete).toBe(true)
    expect(onProgress).toHaveBeenCalledWith('tx2', 2, 2)
    assembler.destroy()
  })

  it('rejects duplicate chunks', async () => {
    const key = await generateRoomKey()
    const assembler = new MediaAssembler()
    const chunk = await makeChunk(key, 'tx3', 0, 2, new Uint8Array([1]))
    await assembler.handleChunk(chunk, key)
    const dup = await assembler.handleChunk(chunk, key)
    expect(dup).toBeNull()
    assembler.destroy()
  })

  it('rejects chunks with seq out of bounds', async () => {
    const key = await generateRoomKey()
    const assembler = new MediaAssembler()
    const chunk = await makeChunk(key, 'tx4', 5, 2, new Uint8Array([1]))
    const result = await assembler.handleChunk(chunk, key)
    expect(result).toBeNull()
    assembler.destroy()
  })

  it('rejects total exceeding MAX_CHUNKS', async () => {
    const key = await generateRoomKey()
    const assembler = new MediaAssembler()
    const chunk = await makeChunk(key, 'tx5', 0, 101, new Uint8Array([1]))
    const result = await assembler.handleChunk(chunk, key)
    expect(result).toBeNull()
    assembler.destroy()
  })

  it('returns error on decryption failure', async () => {
    const key1 = await generateRoomKey()
    const key2 = await generateRoomKey()
    const assembler = new MediaAssembler()
    const chunk = await makeChunk(key1, 'tx6', 0, 1, new Uint8Array([1]))
    const result = await assembler.handleChunk(chunk, key2)
    expect(result.error).toBe(true)
    assembler.destroy()
  })

  it('sanitizes path traversal in fileName', async () => {
    const key = await generateRoomKey()
    const assembler = new MediaAssembler()
    const chunk = {
      type: 'media',
      payload: JSON.stringify({
        transferId: 'tx7',
        seq: 0,
        total: 1,
        mimeType: 'text/plain',
        fileName: '../../../etc/passwd',
        fileSize: 1,
        chunk: await encryptBytes(key, new Uint8Array([1])),
      }),
    }
    const result = await assembler.handleChunk(chunk, key)
    expect(result.complete).toBe(true)
    expect(result.fileName).not.toContain('/')
    expect(result.fileName).not.toContain('..')
    assembler.destroy()
  })
})
