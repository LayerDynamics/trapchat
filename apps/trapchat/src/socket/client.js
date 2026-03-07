const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_ATTEMPTS = 20;

export class TrapChatClient {
  #ws = null;
  #listeners = new Map();
  #url;
  #reconnecting = false;
  #reconnectAttempts = 0;
  #reconnectTimer = null;
  #lastRoom = null;
  #pendingQueue = [];
  #peerId = null;

  constructor(url) {
    this.#url = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(this.#url);

      this.#ws.onopen = () => {
        this.#reconnectAttempts = 0;
        this.#emit('open');
        // Rejoin room after reconnect
        if (this.#reconnecting && this.#lastRoom) {
          this.send('join', this.#lastRoom, null);
          this.#reconnecting = false;
        }
        // Flush any messages queued while disconnected
        this.#flushQueue();
        resolve();
      };

      this.#ws.onerror = (err) => {
        this.#emit('error', err);
        reject(err);
      };

      this.#ws.onclose = (e) => {
        this.#emit('close', e);
        this.#attemptReconnect();
      };

      this.#ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'welcome' && data.id) {
            this.#peerId = data.id;
          }
          this.#emit('message', data);
          if (data.type) {
            this.#emit(data.type, data);
          }
        } catch {
          this.#emit('message', e.data);
        }
      };
    });
  }

  disconnect() {
    this.#clearReconnect();
    this.#lastRoom = null;
    this.#pendingQueue = [];
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
  }

  /**
   * Send a message. Returns true if sent immediately, false if queued or dropped.
   * Chat/media messages are queued when disconnected (up to 200) and flushed on reconnect.
   */
  send(type, room, payload, { msgId } = {}) {
    if (type === 'join') {
      this.#lastRoom = room;
    } else if (type === 'leave') {
      this.#lastRoom = null;
    }

    const msg = JSON.stringify({ id: crypto.randomUUID(), msgId: msgId || crypto.randomUUID(), type, room, payload, timestamp: Date.now() });

    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      // Queue chat/media messages for delivery after reconnect
      if (type === 'chat' || type === 'media') {
        if (this.#pendingQueue.length < 200) {
          this.#pendingQueue.push(msg);
        }
        this.#emit('queued', { type, room });
      }
      return false;
    }

    this.#ws.send(msg);
    return true;
  }

  on(event, fn) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  #emit(event, data) {
    const fns = this.#listeners.get(event);
    if (fns) fns.forEach(fn => fn(data));
  }

  #flushQueue() {
    while (this.#pendingQueue.length > 0) {
      const msg = this.#pendingQueue.shift();
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(msg);
      }
    }
  }

  #attemptReconnect() {
    if (!this.#lastRoom) return; // Only reconnect if user was in a room
    if (this.#reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.#emit('reconnect_failed', { attempts: this.#reconnectAttempts });
      this.#reconnecting = false;
      return;
    }
    this.#reconnecting = true;
    const base = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, this.#reconnectAttempts),
      MAX_RECONNECT_DELAY
    );
    // Add random jitter (0-50% of base delay) to prevent thundering herd
    const jitter = Math.random() * base * 0.5;
    const delay = Math.min(base + jitter, MAX_RECONNECT_DELAY);
    this.#reconnectAttempts++;
    this.#emit('reconnecting', { attempt: this.#reconnectAttempts, delay });
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // connect rejection triggers onerror → onclose → retry
      });
    }, delay);
  }

  #clearReconnect() {
    this.#reconnecting = false;
    this.#reconnectAttempts = 0;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /** Send a raw pre-serialized message string. */
  sendRaw(msg) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(msg)
      return true
    }
    return false
  }

  /** Emit an event externally (e.g., from WebRTC data channel). */
  emit(event, data) {
    this.#emit(event, data)
  }

  /** Emit a P2P event with namespace prefix to avoid collisions with server events. */
  emitP2P(event, data) {
    this.#emit(`p2p:${event}`, data)
  }

  /** Server-assigned peer ID (available after connect). */
  get peerId() {
    return this.#peerId;
  }

  get connected() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }
}
