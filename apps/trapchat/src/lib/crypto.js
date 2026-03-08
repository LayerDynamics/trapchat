const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 600000;
const KDF_CONTEXT = 'trapchat:pbkdf2:v1';

export function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function generateRoomKey() {
  const key = await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
  return key;
}

export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    encoded
  );
  // Prepend IV to ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(result);
}

export async function decrypt(key, encoded) {
  const data = base64ToUint8(encoded);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

export async function deriveRoomKey(roomName, passphrase, salt) {
  if (!passphrase) {
    throw new Error('deriveRoomKey requires a passphrase — room name alone is not secret');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    throw new Error('deriveRoomKey requires a 32-byte Uint8Array salt');
  }
  const enc = new TextEncoder();
  const material = `${roomName}:${passphrase}`;
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(material),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  // Combined salt: random salt (32 bytes) || SHA-256(pepper + roomName) (32 bytes)
  const saltInput = enc.encode(`${KDF_CONTEXT}:${roomName}`);
  const saltHash = await crypto.subtle.digest('SHA-256', saltInput);
  const roomHash = new Uint8Array(saltHash);
  const combinedSalt = new Uint8Array(64);
  combinedSalt.set(salt, 0);
  combinedSalt.set(roomHash, 32);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: combinedSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    bytes
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(result);
}

export async function decryptBytes(key, encoded) {
  const data = base64ToUint8(encoded);
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}

export async function encryptMediaEnvelope(key, chunkData, metadata) {
  const envelope = JSON.stringify({
    ...metadata,
    data: uint8ToBase64(chunkData),
  });
  return encrypt(key, envelope);
}

export async function decryptMediaEnvelope(key, ciphertext) {
  const json = await decrypt(key, ciphertext);
  const parsed = JSON.parse(json);
  const { data, ...metadata } = parsed;
  if (typeof data !== 'string') {
    throw new Error('decryptMediaEnvelope: missing or invalid data field');
  }
  return { chunkData: base64ToUint8(data), metadata };
}

export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return uint8ToBase64(new Uint8Array(raw));
}

export async function importKey(base64) {
  const raw = base64ToUint8(base64);
  return crypto.subtle.importKey('raw', raw, ALGO, true, ['encrypt', 'decrypt']);
}

/**
 * KeyRotator manages periodic key rotation for a room.
 * On rotation, the caller MUST broadcast the new key (encrypted under the old key)
 * to all peers via the onRotate callback. Peers call acceptKey() when they receive it.
 * The previous key is kept for a 30s grace period to decrypt in-flight messages.
 */
export class KeyRotator {
  #currentKey = null;
  #previousKey = null;
  #timer = null;
  #graceTimer = null;
  #onRotate = null;
  #interval;

  /**
   * @param {object} opts
   * @param {number} opts.interval - Rotation interval in ms (default: 30 min)
   * @param {function} opts.onRotate - Called with (newKey, exportedKey, oldKey) after rotation.
   *   The caller MUST broadcast exportedKey encrypted under oldKey to all peers.
   */
  constructor({ interval, onRotate } = {}) {
    this.#interval = interval || 30 * 60 * 1000;
    this.#onRotate = onRotate || null;
  }

  /** Start rotation with an initial key */
  start(key) {
    this.stop();  // Clear any existing timer to prevent leaks
    this.#currentKey = key;
    this.#timer = setInterval(() => this.#rotate(), this.#interval);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#graceTimer) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  get currentKey() {
    return this.#currentKey;
  }

  get previousKey() {
    return this.#previousKey;
  }

  /** Accept a rotated key received from a peer's broadcast (does not trigger onRotate) */
  acceptKey(key) {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#previousKey = this.#currentKey;
    this.#currentKey = key;
    // Clear previous key after grace period
    this.#graceTimer = setTimeout(() => {
      this.#previousKey = null;
      this.#graceTimer = null;
    }, 30000);
  }

  async #rotate() {
    const oldKey = this.#currentKey;
    this.#previousKey = oldKey;
    this.#currentKey = await generateRoomKey();
    const exported = await exportKey(this.#currentKey);
    if (this.#onRotate) {
      this.#onRotate(this.#currentKey, exported, oldKey);
    }
    // Clear previous key after 30s grace period for in-flight messages
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = setTimeout(() => {
      this.#previousKey = null;
      this.#graceTimer = null;
    }, 30000);
  }

  /** Try decrypting with current key, fall back to previous key */
  async decrypt(ciphertext) {
    try {
      return await decrypt(this.#currentKey, ciphertext);
    } catch {
      if (this.#previousKey) {
        try {
          return await decrypt(this.#previousKey, ciphertext);
        } catch {
          // Both keys failed
        }
      }
      throw new Error('decryption failed');
    }
  }

  /** Try decrypting bytes with current key, fall back to previous key */
  async decryptBytes(ciphertext) {
    try {
      return await decryptBytes(this.#currentKey, ciphertext);
    } catch {
      if (this.#previousKey) {
        try {
          return await decryptBytes(this.#previousKey, ciphertext);
        } catch {
          // Both keys failed
        }
      }
      throw new Error('decryption failed');
    }
  }
}

