function buildIceServers() {
  const servers = []

  // STUN servers (configurable, with fallback defaults)
  const stunUrls = import.meta.env.VITE_STUN_URLS
    ? import.meta.env.VITE_STUN_URLS.split(',').map(s => s.trim())
    : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']
  servers.push({ urls: stunUrls })

  // TURN server (optional, required for symmetric NAT traversal)
  const turnUrl = import.meta.env.VITE_TURN_URL
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME || '',
      credential: import.meta.env.VITE_TURN_CREDENTIAL || '',
    })
  }

  return servers
}

const RTC_CONFIG = {
  iceServers: buildIceServers(),
  iceTransportPolicy: import.meta.env.VITE_ICE_TRANSPORT_POLICY || 'all',
}

export class PeerConnection {
  #pc = null
  #dc = null
  #sendSignal
  #onMessage
  #connected = false
  #remoteDescriptionSet = false
  #pendingCandidates = []

  /** @type {(() => void)|null} */
  onConnected = null
  /** @type {(() => void)|null} */
  onDisconnected = null
  /** @type {((stream: MediaStream) => void)|null} */
  onTrack = null

  /**
   * @param {(signal: object) => void} sendSignal — sends signaling data via WS
   * @param {(data: string) => void} onMessage — handles received data channel messages
   */
  constructor(sendSignal, onMessage) {
    this.#sendSignal = sendSignal
    this.#onMessage = onMessage
  }

  get connected() {
    return this.#connected
  }

  async createOffer() {
    this.#pc = new RTCPeerConnection(RTC_CONFIG)
    this.#setupIceHandling()
    this.#setupTrackHandling()

    this.#dc = this.#pc.createDataChannel('trapchat', { ordered: true })
    this.#setupDataChannel(this.#dc)
    this.#setupNegotiationHandling()

    const offer = await this.#pc.createOffer()
    await this.#pc.setLocalDescription(offer)
    this.#sendSignal({ signalType: 'offer', data: this.#pc.localDescription })
  }

  async handleOffer(sdp) {
    if (!this.#pc) {
      this.#pc = new RTCPeerConnection(RTC_CONFIG)
      this.#setupIceHandling()
      this.#setupTrackHandling()

      this.#pc.ondatachannel = (event) => {
        this.#dc = event.channel
        this.#setupDataChannel(this.#dc)
      }

      this.#setupNegotiationHandling()
    }

    await this.#pc.setRemoteDescription(new RTCSessionDescription(sdp))
    this.#remoteDescriptionSet = true
    await this.#flushPendingCandidates()
    const answer = await this.#pc.createAnswer()
    await this.#pc.setLocalDescription(answer)
    this.#sendSignal({ signalType: 'answer', data: this.#pc.localDescription })
  }

  async handleAnswer(sdp) {
    if (!this.#pc) return
    await this.#pc.setRemoteDescription(new RTCSessionDescription(sdp))
    this.#remoteDescriptionSet = true
    await this.#flushPendingCandidates()
  }

  async handleIceCandidate(candidate) {
    if (!this.#pc) return
    if (!candidate) return
    if (!this.#remoteDescriptionSet) {
      this.#pendingCandidates.push(candidate)
      return
    }
    try {
      await this.#pc.addIceCandidate(new RTCIceCandidate(candidate))
    } catch (err) {
      console.warn('failed to add ICE candidate:', err)
    }
  }

  async #flushPendingCandidates() {
    const candidates = this.#pendingCandidates
    this.#pendingCandidates = []
    for (const candidate of candidates) {
      try {
        await this.#pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('failed to add ICE candidate:', err)
      }
    }
  }

  /**
   * Add a local media stream (audio/video) to the peer connection.
   * @param {MediaStream} stream
   */
  async addLocalStream(stream) {
    if (!this.#pc) return
    for (const track of stream.getTracks()) {
      this.#pc.addTrack(track, stream)
    }
  }

  /**
   * Remove all media senders (stops sending audio/video).
   */
  removeLocalStream() {
    if (!this.#pc) return
    for (const sender of this.#pc.getSenders()) {
      if (sender.track) {
        this.#pc.removeTrack(sender)
      }
    }
  }

  /**
   * Send data over the data channel. Returns false if not connected.
   * @param {string} data
   * @returns {boolean}
   */
  send(data) {
    if (!this.#dc || this.#dc.readyState !== 'open') return false
    this.#dc.send(data)
    return true
  }

  close() {
    this.#connected = false
    if (this.#dc) {
      this.#dc.close()
      this.#dc = null
    }
    if (this.#pc) {
      this.#pc.close()
      this.#pc = null
    }
    this.onDisconnected?.()
  }

  #setupNegotiationHandling() {
    this.#pc.onnegotiationneeded = async () => {
      try {
        const offer = await this.#pc.createOffer()
        await this.#pc.setLocalDescription(offer)
        this.#sendSignal({ signalType: 'offer', data: this.#pc.localDescription })
      } catch (err) {
        console.error('Renegotiation failed:', err)
      }
    }
  }

  #setupIceHandling() {
    this.#pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal({ signalType: 'ice', data: event.candidate })
      }
    }
    this.#pc.onconnectionstatechange = () => {
      if (this.#pc?.connectionState === 'disconnected' || this.#pc?.connectionState === 'failed') {
        this.#connected = false
        this.onDisconnected?.()
      }
    }
  }

  #setupTrackHandling() {
    this.#pc.ontrack = (event) => {
      if (event.streams?.[0]) {
        this.onTrack?.(event.streams[0])
      }
    }
  }

  #setupDataChannel(dc) {
    dc.onopen = () => {
      this.#connected = true
      this.onConnected?.()
    }
    dc.onclose = () => {
      this.#connected = false
      this.onDisconnected?.()
    }
    dc.onmessage = (event) => {
      this.#onMessage(event.data)
    }
  }
}

/**
 * PeerMesh manages a full mesh of PeerConnections for multi-peer rooms.
 * Each pair of peers gets its own PeerConnection for data channels and media streams.
 * Max 4 peers for voice/video (mesh scales poorly beyond that).
 */
export class PeerMesh {
  #connections = new Map() // peerId -> PeerConnection
  #onPeerMessage
  #onPeerConnected
  #onPeerDisconnected
  #onPeerTrack

  /**
   * @param {object} opts
   * @param {(peerId: string, data: string) => void} opts.onMessage
   * @param {(peerId: string) => void} opts.onConnected
   * @param {(peerId: string) => void} opts.onDisconnected
   * @param {(peerId: string, stream: MediaStream) => void} opts.onTrack
   */
  constructor({ onMessage, onConnected, onDisconnected, onTrack }) {
    this.#onPeerMessage = onMessage
    this.#onPeerConnected = onConnected
    this.#onPeerDisconnected = onDisconnected
    this.#onPeerTrack = onTrack
  }

  /**
   * Add a peer to the mesh.
   * @param {string} peerId
   * @param {(signal: object) => void} sendSignal
   * @param {boolean} isInitiator — if true, creates offer immediately
   */
  async addPeer(peerId, sendSignal, isInitiator) {
    if (this.#connections.has(peerId)) return

    const pc = new PeerConnection(
      sendSignal,
      (data) => this.#onPeerMessage?.(peerId, data)
    )
    pc.onConnected = () => this.#onPeerConnected?.(peerId)
    pc.onDisconnected = () => this.#onPeerDisconnected?.(peerId)
    pc.onTrack = (stream) => this.#onPeerTrack?.(peerId, stream)

    this.#connections.set(peerId, pc)

    if (isInitiator) {
      await pc.createOffer()
    }
  }

  /**
   * Remove a peer from the mesh.
   * @param {string} peerId
   */
  removePeer(peerId) {
    const pc = this.#connections.get(peerId)
    if (pc) {
      pc.close()
      this.#connections.delete(peerId)
    }
  }

  /**
   * Route a signaling message to the correct PeerConnection.
   * @param {string} fromPeerId
   * @param {object} signal — { signalType, data }
   */
  async handleSignal(fromPeerId, signal) {
    let pc = this.#connections.get(fromPeerId)
    if (!pc && signal.signalType === 'offer') {
      // Lazily create connection for incoming offers
      // The sendSignal will be set up by the consumer via addPeer
      return // consumer should call addPeer first then re-handle
    }
    if (!pc) return

    if (signal.signalType === 'offer') {
      await pc.handleOffer(signal.data)
    } else if (signal.signalType === 'answer') {
      await pc.handleAnswer(signal.data)
    } else if (signal.signalType === 'ice') {
      await pc.handleIceCandidate(signal.data)
    }
  }

  /**
   * Add a media stream to all peer connections in the mesh.
   * @param {MediaStream} stream
   */
  async broadcastStream(stream) {
    for (const pc of this.#connections.values()) {
      await pc.addLocalStream(stream)
    }
  }

  /**
   * Remove media streams from all peer connections.
   */
  removeAllStreams() {
    for (const pc of this.#connections.values()) {
      pc.removeLocalStream()
    }
  }

  get connectedPeers() {
    const peers = []
    for (const [id, pc] of this.#connections) {
      if (pc.connected) peers.push(id)
    }
    return peers
  }

  getConnection(peerId) {
    return this.#connections.get(peerId)
  }

  closeAll() {
    for (const pc of this.#connections.values()) {
      pc.close()
    }
    this.#connections.clear()
  }
}
