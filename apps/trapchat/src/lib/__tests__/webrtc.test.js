// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Must mock import.meta.env before importing the module
vi.stubEnv('VITE_STUN_URLS', 'stun:stun.test:3478')

// Mock RTCPeerConnection and friends
class MockDataChannel {
  readyState = 'connecting'
  onopen = null
  onclose = null
  onmessage = null
  _sent = []
  send(data) { this._sent.push(data) }
  close() { this.readyState = 'closed'; this.onclose?.() }
  _open() { this.readyState = 'open'; this.onopen?.() }
}

class MockRTCPeerConnection {
  localDescription = null
  connectionState = 'new'
  onnegotiationneeded = null
  onicecandidate = null
  onconnectionstatechange = null
  ondatachannel = null
  ontrack = null
  _dc = null
  _senders = []

  createDataChannel(label) {
    this._dc = new MockDataChannel()
    this._dc.label = label
    return this._dc
  }

  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' } }
  async createAnswer() { return { type: 'answer', sdp: 'mock-answer-sdp' } }

  async setLocalDescription(desc) { this.localDescription = desc }
  async setRemoteDescription(desc) { this._remoteDescription = desc }
  async addIceCandidate(candidate) { this._addedCandidates = (this._addedCandidates || []).concat(candidate) }

  addTrack(track) { this._senders.push({ track }); return { track } }
  getSenders() { return this._senders }
  removeTrack(sender) { this._senders = this._senders.filter(s => s !== sender) }
  close() { this.connectionState = 'closed' }
}

class MockRTCSessionDescription {
  constructor(init) { Object.assign(this, init) }
}

class MockRTCIceCandidate {
  constructor(init) { Object.assign(this, init) }
}

beforeEach(() => {
  globalThis.RTCPeerConnection = MockRTCPeerConnection
  globalThis.RTCSessionDescription = MockRTCSessionDescription
  globalThis.RTCIceCandidate = MockRTCIceCandidate
})

afterEach(() => {
  delete globalThis.RTCPeerConnection
  delete globalThis.RTCSessionDescription
  delete globalThis.RTCIceCandidate
})

// Dynamic import to pick up mocks
const { PeerConnection, PeerMesh } = await import('../webrtc.js')

describe('PeerConnection', () => {
  it('creates offer and sends signal', async () => {
    const sendSignal = vi.fn()
    const onMessage = vi.fn()
    const pc = new PeerConnection(sendSignal, onMessage)

    await pc.createOffer()

    expect(sendSignal).toHaveBeenCalledWith({
      signalType: 'offer',
      data: { type: 'offer', sdp: 'mock-offer-sdp' },
    })
  })

  it('handles offer and sends answer', async () => {
    const sendSignal = vi.fn()
    const pc = new PeerConnection(sendSignal, vi.fn())

    await pc.handleOffer({ type: 'offer', sdp: 'remote-offer' })

    expect(sendSignal).toHaveBeenCalledWith({
      signalType: 'answer',
      data: { type: 'answer', sdp: 'mock-answer-sdp' },
    })
  })

  it('starts not connected', () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    expect(pc.connected).toBe(false)
  })

  it('send returns false when no data channel', () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    expect(pc.send('hello')).toBe(false)
  })

  it('queues ICE candidates before remote description', async () => {
    const sendSignal = vi.fn()
    const pc = new PeerConnection(sendSignal, vi.fn())

    // Create PC without setting remote description
    await pc.createOffer()

    // Should queue, not throw
    await pc.handleIceCandidate({ candidate: 'c1', sdpMid: '0' })
    await pc.handleIceCandidate({ candidate: 'c2', sdpMid: '0' })

    // Now set remote description which flushes candidates
    await pc.handleAnswer({ type: 'answer', sdp: 'answer-sdp' })
  })

  it('ignores null ICE candidates', async () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    await pc.createOffer()
    // Should not throw
    await pc.handleIceCandidate(null)
  })

  it('close fires onDisconnected', async () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    const onDisconnected = vi.fn()
    pc.onDisconnected = onDisconnected

    await pc.createOffer()
    pc.close()

    expect(pc.connected).toBe(false)
    // Called twice: once from data channel onclose, once from close() itself
    expect(onDisconnected).toHaveBeenCalled()
  })

  it('handleAnswer is no-op without PC', async () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    // Should not throw
    await pc.handleAnswer({ type: 'answer', sdp: 'sdp' })
  })

  it('handleIceCandidate is no-op without PC', async () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    await pc.handleIceCandidate({ candidate: 'c1' })
  })

  it('addLocalStream is no-op without PC', async () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    await pc.addLocalStream({ getTracks: () => [] })
  })

  it('removeLocalStream is no-op without PC', () => {
    const pc = new PeerConnection(vi.fn(), vi.fn())
    pc.removeLocalStream() // Should not throw
  })
})

describe('PeerMesh', () => {
  it('adds and tracks peers', async () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', vi.fn(), false)
    expect(mesh.getConnection('peer1')).toBeDefined()
    expect(mesh.connectedPeers).toEqual([])
  })

  it('ignores duplicate addPeer', async () => {
    const sendSignal = vi.fn()
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', sendSignal, true)
    const conn1 = mesh.getConnection('peer1')
    await mesh.addPeer('peer1', sendSignal, true)
    expect(mesh.getConnection('peer1')).toBe(conn1)
  })

  it('creates offer when isInitiator=true', async () => {
    const sendSignal = vi.fn()
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', sendSignal, true)
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ signalType: 'offer' })
    )
  })

  it('does not create offer when isInitiator=false', async () => {
    const sendSignal = vi.fn()
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', sendSignal, false)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('removePeer closes connection', async () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', vi.fn(), false)
    mesh.removePeer('peer1')
    expect(mesh.getConnection('peer1')).toBeUndefined()
  })

  it('removePeer is no-op for unknown peer', () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })
    mesh.removePeer('unknown') // Should not throw
  })

  it('handleSignal returns early for unknown peer with non-offer', async () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })
    // Should not throw
    await mesh.handleSignal('unknown', { signalType: 'answer', data: {} })
    await mesh.handleSignal('unknown', { signalType: 'ice', data: {} })
  })

  it('handleSignal routes offer to correct peer', async () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    const sendSignal = vi.fn()
    await mesh.addPeer('peer1', sendSignal, false)

    await mesh.handleSignal('peer1', {
      signalType: 'offer',
      data: { type: 'offer', sdp: 'remote-offer' },
    })

    // Should have sent an answer back
    expect(sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ signalType: 'answer' })
    )
  })

  it('closeAll closes all connections', async () => {
    const mesh = new PeerMesh({
      onMessage: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onTrack: vi.fn(),
    })

    await mesh.addPeer('peer1', vi.fn(), false)
    await mesh.addPeer('peer2', vi.fn(), false)
    mesh.closeAll()

    expect(mesh.getConnection('peer1')).toBeUndefined()
    expect(mesh.getConnection('peer2')).toBeUndefined()
    expect(mesh.connectedPeers).toEqual([])
  })
})
