const ALGO = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

function uint8ToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64) {
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

export async function deriveRoomKey(roomName, passphrase) {
  if (!passphrase) {
    throw new Error('deriveRoomKey requires a passphrase — room name alone is not secret');
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
  // Per-room salt prevents cross-room precomputation attacks.
  // SHA-256 the room name into a fixed-length, unique salt.
  const roomBytes = enc.encode(roomName);
  const saltHash = await crypto.subtle.digest('SHA-256', roomBytes);
  const salt = new Uint8Array(saltHash);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return uint8ToBase64(new Uint8Array(raw));
}

export async function importKey(base64) {
  const raw = base64ToUint8(base64);
  return crypto.subtle.importKey('raw', raw, ALGO, true, ['encrypt', 'decrypt']);
}
