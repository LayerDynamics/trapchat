import { useRef, useCallback } from 'react'
import { encrypt, decrypt, importKey, KeyRotator } from '../lib/crypto.js'

const KEY_ROTATION_INTERVAL = Math.max(
  60000,
  parseInt(import.meta.env.VITE_KEY_ROTATION_INTERVAL || '1800000', 10) || 1800000
)

export function useKeyRotation({ keyRef, clientRef, room, appendMessage }) {
  const rotatorRef = useRef(null)

  const startRotation = useCallback((key) => {
    if (rotatorRef.current) rotatorRef.current.stop()
    rotatorRef.current = new KeyRotator({
      interval: KEY_ROTATION_INTERVAL,
      onRotate: async (newKey, exportedKey, oldKey) => {
        keyRef.current = newKey
        try {
          const encryptedNewKey = await encrypt(oldKey, exportedKey)
          clientRef.current?.send('key_rotation', room, encryptedNewKey)
        } catch (err) {
          console.error('failed to broadcast rotated key:', err)
        }
        appendMessage({
          id: crypto.randomUUID(),
          text: '[key rotated — encryption key updated]',
          time: new Date().toLocaleTimeString(),
          system: true,
        })
      },
    })
    rotatorRef.current.start(key)
  }, [keyRef, clientRef, room, appendMessage])

  const stopRotation = useCallback(() => {
    if (rotatorRef.current) {
      rotatorRef.current.stop()
      rotatorRef.current = null
    }
  }, [])

  const handleKeyRotationMessage = useCallback(async (data) => {
    try {
      const exportedNewKey = rotatorRef.current
        ? await rotatorRef.current.decrypt(data.payload)
        : await decrypt(keyRef.current, data.payload)
      const newKey = await importKey(exportedNewKey)
      keyRef.current = newKey
      if (rotatorRef.current) {
        rotatorRef.current.acceptKey(newKey)
      }
      appendMessage({
        id: crypto.randomUUID(),
        text: '[key rotated by peer — encryption key updated]',
        time: new Date().toLocaleTimeString(),
        system: true,
      })
    } catch {
      appendMessage({
        id: crypto.randomUUID(),
        text: '[key rotation failed — could not decrypt new key]',
        time: new Date().toLocaleTimeString(),
        error: true,
      })
    }
  }, [keyRef, appendMessage])

  const decryptWithRotation = useCallback(async (ciphertext) => {
    if (rotatorRef.current) {
      return rotatorRef.current.decrypt(ciphertext)
    }
    return decrypt(keyRef.current, ciphertext)
  }, [keyRef])

  return { rotatorRef, startRotation, stopRotation, handleKeyRotationMessage, decryptWithRotation }
}
