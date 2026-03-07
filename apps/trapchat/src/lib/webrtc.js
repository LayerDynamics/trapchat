const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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

    this.#dc = this.#pc.createDataChannel('trapchat', { ordered: true })
    this.#setupDataChannel(this.#dc)

    const offer = await this.#pc.createOffer()
    await this.#pc.setLocalDescription(offer)
    this.#sendSignal({ signalType: 'offer', data: this.#pc.localDescription })
  }

  async handleOffer(sdp) {
    this.#pc = new RTCPeerConnection(RTC_CONFIG)
    this.#setupIceHandling()

    this.#pc.ondatachannel = (event) => {
      this.#dc = event.channel
      this.#setupDataChannel(this.#dc)
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
    await this.#pc.addIceCandidate(new RTCIceCandidate(candidate))
  }

  async #flushPendingCandidates() {
    for (const candidate of this.#pendingCandidates) {
      await this.#pc.addIceCandidate(new RTCIceCandidate(candidate))
    }
    this.#pendingCandidates = []
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
