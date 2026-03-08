// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TrapChatClient } from '../client.js'

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = MockWebSocket.CONNECTING
    this.onopen = null
    this.onclose = null
    this.onerror = null
    this.onmessage = null
    this._sent = []
    MockWebSocket._last = this
  }

  send(data) { this._sent.push(data) }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000 })
  }

  // Test helpers
  _open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  _message(data) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  _error(err) {
    this.onerror?.(err)
  }
}

beforeEach(() => {
  globalThis.WebSocket = MockWebSocket
  MockWebSocket._last = null
})

afterEach(() => {
  delete globalThis.WebSocket
})

describe('TrapChatClient', () => {
  it('connects and resolves promise on open', async () => {
    const client = new TrapChatClient('ws://test')
    const connectPromise = client.connect()
    MockWebSocket._last._open()
    await connectPromise
    expect(client.connected).toBe(true)
    client.disconnect()
  })

  it('rejects promise on connection error before open', async () => {
    const client = new TrapChatClient('ws://test')
    const connectPromise = client.connect()
    MockWebSocket._last._error(new Error('refused'))
    await expect(connectPromise).rejects.toBeDefined()
    client.disconnect()
  })

  it('emits open event on connect', async () => {
    const client = new TrapChatClient('ws://test')
    const onOpen = vi.fn()
    client.on('open', onOpen)
    const p = client.connect()
    MockWebSocket._last._open()
    await p
    expect(onOpen).toHaveBeenCalledOnce()
    client.disconnect()
  })

  it('sends JSON messages with required fields', async () => {
    const client = new TrapChatClient('ws://test')
    const p = client.connect()
    MockWebSocket._last._open()
    await p

    client.send('chat', 'room1', 'hello')
    expect(MockWebSocket._last._sent).toHaveLength(1)
    const msg = JSON.parse(MockWebSocket._last._sent[0])
    expect(msg.type).toBe('chat')
    expect(msg.room).toBe('room1')
    expect(msg.payload).toBe('hello')
    expect(msg.id).toBeDefined()
    expect(msg.timestamp).toBeDefined()
    client.disconnect()
  })

  it('tracks joined rooms on join/leave', async () => {
    const client = new TrapChatClient('ws://test')
    const p = client.connect()
    MockWebSocket._last._open()
    await p

    client.send('join', 'room1', '{}')
    expect(client.joinedRooms.has('room1')).toBe(true)

    client.send('leave', 'room1', null)
    expect(client.joinedRooms.has('room1')).toBe(false)
    client.disconnect()
  })

  it('enforces MAX_ROOMS limit', async () => {
    const client = new TrapChatClient('ws://test')
    const onError = vi.fn()
    client.on('error', onError)

    const p = client.connect()
    MockWebSocket._last._open()
    await p

    for (let i = 0; i < 5; i++) {
      client.send('join', `room${i}`, '{}')
    }
    expect(client.joinedRooms.size).toBe(5)

    // 6th room should be rejected
    const result = client.send('join', 'room5', '{}')
    expect(result).toBe(false)
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0].code).toBe('MAX_ROOMS')
    client.disconnect()
  })

  it('queues chat messages when disconnected', () => {
    const client = new TrapChatClient('ws://test')
    const onQueued = vi.fn()
    client.on('queued', onQueued)

    const result = client.send('chat', 'room1', 'offline msg')
    expect(result).toBe(false)
    expect(onQueued).toHaveBeenCalledWith({ type: 'chat', room: 'room1' })
  })

  it('does not queue non-chat/media messages when disconnected', () => {
    const client = new TrapChatClient('ws://test')
    const onQueued = vi.fn()
    client.on('queued', onQueued)

    client.send('typing', 'room1', '{}')
    expect(onQueued).not.toHaveBeenCalled()
  })

  it('on() returns unsubscribe function', async () => {
    const client = new TrapChatClient('ws://test')
    const handler = vi.fn()
    const unsub = client.on('message', handler)

    const p = client.connect()
    MockWebSocket._last._open()
    await p

    MockWebSocket._last._message({ type: 'chat', payload: 'hi' })
    expect(handler).toHaveBeenCalledOnce()

    unsub()
    MockWebSocket._last._message({ type: 'chat', payload: 'hi2' })
    expect(handler).toHaveBeenCalledOnce() // still 1
    client.disconnect()
  })

  it('emits type-specific events', async () => {
    const client = new TrapChatClient('ws://test')
    const onChat = vi.fn()
    client.on('chat', onChat)

    const p = client.connect()
    MockWebSocket._last._open()
    await p

    MockWebSocket._last._message({ type: 'chat', payload: 'hello' })
    expect(onChat).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat', payload: 'hello' }))
    client.disconnect()
  })

  it('sets peerId from welcome message', async () => {
    const client = new TrapChatClient('ws://test')
    const p = client.connect()
    MockWebSocket._last._open()
    await p

    expect(client.peerId).toBeNull()
    MockWebSocket._last._message({ type: 'welcome', id: 'peer-123' })
    expect(client.peerId).toBe('peer-123')
    client.disconnect()
  })

  it('disconnect clears state', async () => {
    const client = new TrapChatClient('ws://test')
    const p = client.connect()
    MockWebSocket._last._open()
    await p

    client.send('join', 'room1', '{}')
    client.disconnect()

    expect(client.connected).toBe(false)
    expect(client.joinedRooms.size).toBe(0)
  })

  it('sendRaw only allows signal type', async () => {
    const client = new TrapChatClient('ws://test')
    const p = client.connect()
    MockWebSocket._last._open()
    await p

    expect(client.sendRaw(JSON.stringify({ type: 'chat', room: 'r' }))).toBe(false)
    expect(client.sendRaw(JSON.stringify({ type: 'signal', room: 'r' }))).toBe(true)
    expect(client.sendRaw('not json')).toBe(false)
    expect(client.sendRaw(JSON.stringify({ type: 'signal' }))).toBe(false) // missing room
    client.disconnect()
  })

  it('emitP2P emits with p2p: prefix', () => {
    const client = new TrapChatClient('ws://test')
    const handler = vi.fn()
    client.on('p2p:message', handler)

    client.emitP2P('message', { text: 'hello' })
    expect(handler).toHaveBeenCalledWith({ text: 'hello' })
  })
})
