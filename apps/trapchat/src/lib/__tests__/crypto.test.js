import { describe, it, expect } from 'vitest'
import {
  generateRoomKey, encrypt, decrypt,
  encryptBytes, decryptBytes,
  exportKey, importKey,
  deriveRoomKey, KeyRotator,
  encryptMediaEnvelope, decryptMediaEnvelope,
} from '../crypto.js'

describe('crypto', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('encrypts and decrypts text correctly', async () => {
      const key = await generateRoomKey()
      const plaintext = 'hello trapchat'
      const ciphertext = await encrypt(key, plaintext)
      const decrypted = await decrypt(key, ciphertext)
      expect(decrypted).toBe(plaintext)
    })

    it('produces different ciphertexts for same plaintext (unique IV)', async () => {
      const key = await generateRoomKey()
      const a = await encrypt(key, 'same')
      const b = await encrypt(key, 'same')
      expect(a).not.toBe(b)
    })

    it('fails to decrypt with wrong key', async () => {
      const key1 = await generateRoomKey()
      const key2 = await generateRoomKey()
      const ciphertext = await encrypt(key1, 'secret')
      await expect(decrypt(key2, ciphertext)).rejects.toThrow()
    })
  })

  describe('encryptBytes/decryptBytes round-trip', () => {
    it('encrypts and decrypts bytes correctly', async () => {
      const key = await generateRoomKey()
      const original = new Uint8Array([1, 2, 3, 4, 5])
      const ciphertext = await encryptBytes(key, original)
      const decrypted = await decryptBytes(key, ciphertext)
      expect(decrypted).toEqual(original)
    })
  })

  describe('exportKey/importKey', () => {
    it('exports and re-imports a key that works', async () => {
      const key = await generateRoomKey()
      const exported = await exportKey(key)
      const reimported = await importKey(exported)
      const plaintext = 'round-trip key test'
      const ciphertext = await encrypt(key, plaintext)
      const decrypted = await decrypt(reimported, ciphertext)
      expect(decrypted).toBe(plaintext)
    })
  })

  describe('deriveRoomKey', () => {
    const testSalt = new Uint8Array(32); testSalt.fill(42)

    it('derives the same key for same room+passphrase+salt', async () => {
      const k1 = await deriveRoomKey('room', 'pass', testSalt)
      const k2 = await deriveRoomKey('room', 'pass', testSalt)
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).toBe(e2)
    })

    it('derives different keys for different passphrases', async () => {
      const k1 = await deriveRoomKey('room', 'pass1', testSalt)
      const k2 = await deriveRoomKey('room', 'pass2', testSalt)
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).not.toBe(e2)
    })

    it('derives different keys for different salts', async () => {
      const salt2 = new Uint8Array(32); salt2.fill(99)
      const k1 = await deriveRoomKey('room', 'pass', testSalt)
      const k2 = await deriveRoomKey('room', 'pass', salt2)
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).not.toBe(e2)
    })

    it('throws without a passphrase', async () => {
      await expect(deriveRoomKey('room', '', testSalt)).rejects.toThrow()
    })

    it('throws without a salt', async () => {
      await expect(deriveRoomKey('room', 'pass')).rejects.toThrow('32-byte Uint8Array salt')
    })

    it('throws with wrong salt length', async () => {
      await expect(deriveRoomKey('room', 'pass', new Uint8Array(16))).rejects.toThrow('32-byte Uint8Array salt')
    })

    it('throws with string salt (type check)', async () => {
      await expect(deriveRoomKey('room', 'pass', 'a'.repeat(32))).rejects.toThrow('Uint8Array')
    })

    it('derives different keys for different room names', async () => {
      const k1 = await deriveRoomKey('room-a', 'pass', testSalt)
      const k2 = await deriveRoomKey('room-b', 'pass', testSalt)
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).not.toBe(e2)
    })
  })

  describe('KeyRotator', () => {
    it('decrypts with current key', async () => {
      const key = await generateRoomKey()
      const rotator = new KeyRotator()
      rotator.start(key)

      const ciphertext = await encrypt(key, 'hello')
      const decrypted = await rotator.decrypt(ciphertext)
      expect(decrypted).toBe('hello')
      rotator.stop()
    })

    it('falls back to previous key after acceptKey', async () => {
      const oldKey = await generateRoomKey()
      const newKey = await generateRoomKey()
      const rotator = new KeyRotator()
      rotator.start(oldKey)

      const ciphertext = await encrypt(oldKey, 'old message')
      rotator.acceptKey(newKey)

      // Should still decrypt with previous key during grace period
      const decrypted = await rotator.decrypt(ciphertext)
      expect(decrypted).toBe('old message')
      rotator.stop()
    })

    it('decrypts with new key after acceptKey', async () => {
      const oldKey = await generateRoomKey()
      const newKey = await generateRoomKey()
      const rotator = new KeyRotator()
      rotator.start(oldKey)

      rotator.acceptKey(newKey)
      const ciphertext = await encrypt(newKey, 'new message')
      const decrypted = await rotator.decrypt(ciphertext)
      expect(decrypted).toBe('new message')
      rotator.stop()
    })

    it('throws when both keys fail', async () => {
      const key = await generateRoomKey()
      const wrongKey = await generateRoomKey()
      const rotator = new KeyRotator()
      rotator.start(key)

      const ciphertext = await encrypt(wrongKey, 'bad')
      await expect(rotator.decrypt(ciphertext)).rejects.toThrow('decryption failed')
      rotator.stop()
    })

    it('decryptBytes falls back to previous key', async () => {
      const oldKey = await generateRoomKey()
      const newKey = await generateRoomKey()
      const rotator = new KeyRotator()
      rotator.start(oldKey)

      const bytes = new Uint8Array([10, 20, 30])
      const ciphertext = await encryptBytes(oldKey, bytes)
      rotator.acceptKey(newKey)

      const decrypted = await rotator.decryptBytes(ciphertext)
      expect(decrypted).toEqual(bytes)
      rotator.stop()
    })

    it('automatic rotation generates new key and calls onRotate', async () => {
      const key = await generateRoomKey()
      const originalExported = await exportKey(key)
      let rotatedKey = null
      let rotatedExported = null
      let rotatedOldKey = null

      const rotator = new KeyRotator({
        interval: 50,
        onRotate: (newKey, exported, oldKey) => {
          rotatedKey = newKey
          rotatedExported = exported
          rotatedOldKey = oldKey
        },
      })
      rotator.start(key)

      // Wait for one rotation
      await new Promise(r => setTimeout(r, 100))

      expect(rotatedKey).not.toBeNull()
      expect(rotatedExported).not.toBeNull()
      expect(rotatedOldKey).not.toBeNull()

      // New key should differ from original
      const newExported = await exportKey(rotatedKey)
      expect(newExported).not.toBe(originalExported)
      expect(rotatedExported).toBe(newExported)

      // Old key passed to callback should match original
      const oldExported = await exportKey(rotatedOldKey)
      expect(oldExported).toBe(originalExported)

      // Can encrypt with new key and decrypt via rotator
      const ciphertext = await encrypt(rotatedKey, 'after rotation')
      const decrypted = await rotator.decrypt(ciphertext)
      expect(decrypted).toBe('after rotation')

      rotator.stop()
    })

    it('clears existing timer on double start (no leak)', async () => {
      let rotateCount = 0
      const key = await generateRoomKey()
      const rotator = new KeyRotator({
        interval: 50,
        onRotate: () => { rotateCount++ },
      })

      rotator.start(key)
      rotator.start(key) // Should clear first timer

      // Wait long enough for ~1 rotation but not 2
      await new Promise(r => setTimeout(r, 100))

      // Should only have rotated once (one active timer), not twice
      // With two leaked timers at 50ms, after 100ms we'd see 2+ rotations
      expect(rotateCount).toBe(1)

      rotator.stop()
    })
  })

  describe('encryptMediaEnvelope/decryptMediaEnvelope', () => {
    it('round-trips chunk data and metadata', async () => {
      const key = await generateRoomKey()
      const chunkData = new Uint8Array([1, 2, 3, 4, 5])
      const metadata = { fileName: 'test.png', mimeType: 'image/png', fileSize: 12345 }
      const ciphertext = await encryptMediaEnvelope(key, chunkData, metadata)
      const result = await decryptMediaEnvelope(key, ciphertext)
      expect(result.chunkData).toEqual(chunkData)
      expect(result.metadata.fileName).toBe('test.png')
      expect(result.metadata.mimeType).toBe('image/png')
      expect(result.metadata.fileSize).toBe(12345)
    })

    it('fails to decrypt with wrong key (proves encryption not just encoding)', async () => {
      const key1 = await generateRoomKey()
      const key2 = await generateRoomKey()
      const chunkData = new Uint8Array([10, 20, 30])
      const metadata = { fileName: 'secret-document.pdf', mimeType: 'application/pdf', fileSize: 99999 }
      const ciphertext = await encryptMediaEnvelope(key1, chunkData, metadata)
      await expect(decryptMediaEnvelope(key2, ciphertext)).rejects.toThrow()
    })

    it('throws on missing data field in envelope', async () => {
      const key = await generateRoomKey()
      const badEnvelope = await encrypt(key, JSON.stringify({ fileName: 'test.txt' }))
      await expect(decryptMediaEnvelope(key, badEnvelope)).rejects.toThrow('missing or invalid data')
    })
  })
})
