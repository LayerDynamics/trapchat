// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { MediaAssembler, sendMedia, sendCanvas } from '../media.js'
import { generateRoomKey, encryptMediaEnvelope } from '../crypto.js'

describe('MediaAssembler', () => {
  async function makeChunk(key, transferId, seq, total, data, opts = {}) {
    const fileName = opts.fileName || 'test.bin'
    const mimeType = opts.mimeType || 'application/octet-stream'
    const fileSize = opts.fileSize || data.length
    const chunk = await encryptMediaEnvelope(key, data, { mimeType, fileName, fileSize })
    return {
      type: 'media',
      payload: JSON.stringify({
        transferId,
        seq,
        total,
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
    const chunk = await makeChunk(key, 'tx7', 0, 1, new Uint8Array([1]), {
      fileName: '../../../etc/passwd',
    })
    const result = await assembler.handleChunk(chunk, key)
    expect(result.complete).toBe(true)
    expect(result.fileName).not.toContain('/')
    expect(result.fileName).not.toContain('..')
    assembler.destroy()
  })
})

describe('sendMedia', () => {
  function mockClient() {
    return { send: vi.fn() }
  }

  function mockFile(name, bytes, type = '') {
    const buf = new Uint8Array(bytes).buffer
    return {
      name,
      size: bytes.length,
      type,
      arrayBuffer: async () => buf,
    }
  }

  it('sends a small file as a single chunk', async () => {
    const client = mockClient()
    const key = await generateRoomKey()
    const file = mockFile('test.bin', [1, 2, 3])

    const result = await sendMedia(client, key, 'room1', file)
    expect(result.total).toBe(1)
    expect(result.fileName).toBe('test.bin')
    expect(client.send).toHaveBeenCalledOnce()
    expect(client.send.mock.calls[0][0]).toBe('media')
    expect(client.send.mock.calls[0][1]).toBe('room1')

    // Payload should be valid JSON with expected fields
    const payload = JSON.parse(client.send.mock.calls[0][2])
    expect(payload.transferId).toBeDefined()
    expect(payload.seq).toBe(0)
    expect(payload.total).toBe(1)
    expect(payload.chunk).toBeDefined()
  })

  it('calls onProgress callback', async () => {
    const client = mockClient()
    const key = await generateRoomKey()
    const file = mockFile('test.bin', [1, 2, 3])
    const onProgress = vi.fn()

    await sendMedia(client, key, 'room1', file, onProgress)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })

  it('rejects files over 25MB', async () => {
    const client = mockClient()
    const key = await generateRoomKey()
    const file = {
      name: 'huge.bin',
      size: 26 * 1024 * 1024,
      type: '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }

    await expect(sendMedia(client, key, 'room1', file)).rejects.toThrow('File too large')
  })

  it('detects PNG mime type from magic bytes', async () => {
    const client = mockClient()
    const key = await generateRoomKey()
    // PNG magic bytes: 89 50 4E 47
    const pngBytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]
    const file = mockFile('image.png', pngBytes)

    const result = await sendMedia(client, key, 'room1', file)
    expect(result.mimeType).toBe('image/png')
  })
})

describe('sendCanvas', () => {
  it('converts canvas to PNG and sends', async () => {
    const client = { send: vi.fn() }
    const key = await generateRoomKey()

    // Mock canvas.toBlob
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])
    const mockBlob = new Blob([pngBytes], { type: 'image/png' })
    const canvas = {
      toBlob: (cb) => cb(mockBlob),
    }

    const result = await sendCanvas(client, key, 'room1', canvas)
    expect(result.mimeType).toBe('image/png')
    expect(result.fileName).toMatch(/^canvas-\d+\.png$/)
    expect(client.send).toHaveBeenCalled()
  })

  it('rejects if canvas.toBlob fails', async () => {
    const client = { send: vi.fn() }
    const key = await generateRoomKey()
    const canvas = {
      toBlob: (cb) => cb(null),
    }

    await expect(sendCanvas(client, key, 'room1', canvas)).rejects.toThrow('canvas toBlob failed')
  })
})
