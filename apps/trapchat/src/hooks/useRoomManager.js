import { useState, useRef, useCallback, useEffect } from 'react'
import QRCode from 'qrcode'
import { generateRoomKey, exportKey, importKey, deriveRoomKey, uint8ToBase64, base64ToUint8 } from '../lib/crypto.js'

const MAX_MESSAGES = 500
const MAX_ROOM_NAME_LEN = 64
const MAX_ROOMS = 5

function defaultRoomState() {
  return {
    messages: [], input: '', expiresAt: null, peerCount: 0,
    peerNicknames: {}, typingText: '', messageReceipts: {},
    uploadProgress: null, downloadProgress: null, isP2P: false,
    shareLink: '', copied: false, showQR: false, qrDataURL: '',
    unreadCount: 0,
  }
}

export function useRoomManager() {
  const [rooms, setRooms] = useState(new Map())
  const roomsRef = useRef(rooms)
  roomsRef.current = rooms
  const [activeRoom, setActiveRoom] = useState('')
  const [view, setView] = useState('join')
  const [status, setStatus] = useState('disconnected')

  const keyRefs = useRef(new Map()) // room -> CryptoKey
  const activeRoomRef = useRef(activeRoom)
  activeRoomRef.current = activeRoom

  const activeKeyRef = useRef(null)
  useEffect(() => {
    activeKeyRef.current = keyRefs.current.get(activeRoom) || null
  }, [activeRoom, rooms])

  // Check URL fragment for key on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName, keyFragment] = hash.split('/', 2)
      if (roomName && keyFragment) {
        keyRefs.current.set(decodeURIComponent(roomName), keyFragment)
      }
    }
  }, [])

  const getRoomState = useCallback((roomName) => {
    return rooms.get(roomName) || defaultRoomState()
  }, [rooms])

  const updateRoomState = useCallback((roomName, updater) => {
    setRooms(prev => {
      const next = new Map(prev)
      const current = next.get(roomName) || defaultRoomState()
      next.set(roomName, typeof updater === 'function' ? updater(current) : { ...current, ...updater })
      return next
    })
  }, [])

  const appendMessageToRoom = useCallback((roomName, msg) => {
    setRooms(prev => {
      const next = new Map(prev)
      const current = next.get(roomName)
      if (!current) return prev
      let messages = [...current.messages, msg]
      if (messages.length > MAX_MESSAGES) {
        const evicted = messages.slice(0, messages.length - MAX_MESSAGES)
        for (const m of evicted) {
          if (m.media?.url && m.media.url.startsWith('blob:')) {
            URL.revokeObjectURL(m.media.url)
          }
        }
        messages = messages.slice(messages.length - MAX_MESSAGES)
      }
      const unreadCount = roomName !== activeRoomRef.current
        ? (current.unreadCount || 0) + 1
        : current.unreadCount
      next.set(roomName, { ...current, messages, unreadCount })
      return next
    })
  }, [])

  const switchRoom = useCallback((roomName) => {
    setActiveRoom(roomName)
    updateRoomState(roomName, (s) => ({ ...s, unreadCount: 0 }))
    activeKeyRef.current = keyRefs.current.get(roomName) || null
  }, [updateRoomState])

  // QR code generation for active room
  const activeState = getRoomState(activeRoom)
  useEffect(() => {
    if (!activeState.shareLink) return
    let cancelled = false
    QRCode.toDataURL(activeState.shareLink, { width: 200, margin: 2 })
      .then((url) => { if (!cancelled) updateRoomState(activeRoom, { qrDataURL: url }) })
      .catch(() => { if (!cancelled) updateRoomState(activeRoom, { qrDataURL: '' }) })
    return () => { cancelled = true }
  }, [activeState.shareLink, activeRoom, updateRoomState])

  const copyShareLink = useCallback(async () => {
    const link = rooms.get(activeRoom)?.shareLink
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      updateRoomState(activeRoom, { copied: true })
      setTimeout(() => updateRoomState(activeRoom, { copied: false }), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = link
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(link)
        } else {
          document.execCommand('copy')
        }
      } catch {
        document.execCommand('copy')
      }
      document.body.removeChild(textarea)
      updateRoomState(activeRoom, { copied: true })
      setTimeout(() => updateRoomState(activeRoom, { copied: false }), 2000)
    }
  }, [activeRoom, rooms, updateRoomState])

  const saltRefs = useRef(new Map()) // room -> Uint8Array(32)
  const passphraseRefs = useRef(new Map()) // room -> passphrase (for deferred derivation)

  const setupRoomKey = useCallback(async (trimmed, passphrase, salt) => {
    let key = keyRefs.current.get(trimmed)
    let shareLink = ''
    if (typeof key === 'string' && key) {
      key = await importKey(key)
      keyRefs.current.set(trimmed, key)
      history.replaceState(null, '', window.location.pathname)
    } else if (passphrase.trim()) {
      // Generate salt if not provided
      const roomSalt = salt || crypto.getRandomValues(new Uint8Array(32))
      saltRefs.current.set(trimmed, roomSalt)
      passphraseRefs.current.set(trimmed, passphrase)
      key = await deriveRoomKey(trimmed, passphrase, roomSalt)
      keyRefs.current.set(trimmed, key)
      shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(trimmed)}/`
    } else if (!key) {
      key = await generateRoomKey()
      keyRefs.current.set(trimmed, key)
      const exported = await exportKey(key)
      shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(trimmed)}/${exported}`
      history.replaceState(null, '', window.location.pathname)
    }
    if (!shareLink && key) {
      try {
        const exported = await exportKey(key)
        shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(trimmed)}/${exported}`
      } catch {
        shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(trimmed)}/`
      }
    }
    return { key, shareLink }
  }, [])

  const removeRoom = useCallback((roomName) => {
    keyRefs.current.delete(roomName)
    saltRefs.current.delete(roomName)
    passphraseRefs.current.delete(roomName)
    setRooms(prev => {
      const next = new Map(prev)
      const current = next.get(roomName)
      if (current) {
        for (const m of current.messages) {
          if (m.media?.url && m.media.url.startsWith('blob:')) {
            URL.revokeObjectURL(m.media.url)
          }
        }
      }
      next.delete(roomName)
      return next
    })
  }, [])

  return {
    rooms, roomsRef, setRooms, activeRoom, setActiveRoom, view, setView,
    status, setStatus, keyRefs, activeKeyRef, activeRoomRef,
    saltRefs, passphraseRefs,
    getRoomState, updateRoomState, appendMessageToRoom,
    switchRoom, copyShareLink, setupRoomKey, removeRoom,
    MAX_ROOMS, MAX_ROOM_NAME_LEN, MAX_TEXT_LENGTH: 50000,
  }
}
