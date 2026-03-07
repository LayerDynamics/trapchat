import { describe, it, expect } from 'vitest'
import {
  generateRoomKey, encrypt, decrypt,
  encryptBytes, decryptBytes,
  exportKey, importKey,
  deriveRoomKey, KeyRotator,
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
    it('derives the same key for same room+passphrase', async () => {
      const k1 = await deriveRoomKey('room', 'pass')
      const k2 = await deriveRoomKey('room', 'pass')
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).toBe(e2)
    })

    it('derives different keys for different passphrases', async () => {
      const k1 = await deriveRoomKey('room', 'pass1')
      const k2 = await deriveRoomKey('room', 'pass2')
      const e1 = await exportKey(k1)
      const e2 = await exportKey(k2)
      expect(e1).not.toBe(e2)
    })

    it('throws without a passphrase', async () => {
      await expect(deriveRoomKey('room', '')).rejects.toThrow()
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
  })
})
