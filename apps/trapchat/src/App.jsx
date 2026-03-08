import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import { TrapChatClient } from './socket/client.js'
import { generateRoomKey, exportKey, importKey, encrypt, deriveRoomKey } from './lib/crypto.js'
import { useKeyRotation } from './hooks/useKeyRotation.js'
import { useTypingIndicator } from './hooks/useTypingIndicator.js'
import { useMediaTransfer } from './hooks/useMediaTransfer.js'
import { PeerConnection, PeerMesh } from './lib/webrtc.js'
import JoinView from './components/JoinView.jsx'
import ChatView from './components/ChatView.jsx'
import './App.css'

const MAX_MESSAGES = 500
const MAX_ROOM_NAME_LEN = 64
const MAX_TEXT_LENGTH = 50000
const MAX_ROOMS = 5

function App() {
  // Multi-room state: Map<roomName, roomState>
  const [rooms, setRooms] = useState(new Map())
  const [activeRoom, setActiveRoom] = useState('')
  const [view, setView] = useState('join')
  const [status, setStatus] = useState('disconnected')
  const [nickname, setNickname] = useState('')
  const [showJoinModal, setShowJoinModal] = useState(false)

  // Join form state (used for both initial join and modal)
  const [joinRoom, setJoinRoom] = useState(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName] = hash.split('/', 2)
      if (roomName) return decodeURIComponent(roomName)
    }
    return ''
  })
  const [passphrase, setPassphrase] = useState('')
  const [ttl, setTtl] = useState(0)

  // Call state
  const [callActive, setCallActive] = useState(false)
  const [callType, setCallType] = useState(null) // 'audio' | 'video'
  const [localStream, setLocalStream] = useState(null)
  const [remoteStreams, setRemoteStreams] = useState(new Map()) // peerId -> MediaStream
  const [callMuted, setCallMuted] = useState(false)
  const [callVideoOff, setCallVideoOff] = useState(false)

  const keyRefs = useRef(new Map()) // room -> CryptoKey
  const bottomRef = useRef(null)
  const unsubsRef = useRef([])
  const clientRef = useRef(null)
  const peerNicknamesRef = useRef({}) // current active room's nicknames
  const peerMeshRef = useRef(new Map()) // room -> PeerMesh
  const prevPeerCountRef = useRef(new Map()) // room -> prevCount
  const intentionalDisconnectRef = useRef(false)
  const observerRef = useRef(null)
  const localVideoRef = useRef(null)

  // Helper to get/set per-room state
  const getRoomState = useCallback((roomName) => {
    return rooms.get(roomName) || {
      messages: [], input: '', expiresAt: null, peerCount: 0,
      peerNicknames: {}, typingText: '', messageReceipts: {},
      uploadProgress: null, downloadProgress: null, isP2P: false,
      shareLink: '', copied: false, showQR: false, qrDataURL: '',
      unreadCount: 0,
    }
  }, [rooms])

  const updateRoomState = useCallback((roomName, updater) => {
    setRooms(prev => {
      const next = new Map(prev)
      const current = next.get(roomName) || {
        messages: [], input: '', expiresAt: null, peerCount: 0,
        peerNicknames: {}, typingText: '', messageReceipts: {},
        uploadProgress: null, downloadProgress: null, isP2P: false,
        shareLink: '', copied: false, showQR: false, qrDataURL: '',
        unreadCount: 0,
      }
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

  // Keep a ref of activeRoom for use in callbacks
  const activeRoomRef = useRef(activeRoom)
  activeRoomRef.current = activeRoom

  // Hooks that need the active room context
  const activeKeyRef = useRef(null)
  // Sync activeKeyRef with the active room's key
  useEffect(() => {
    activeKeyRef.current = keyRefs.current.get(activeRoom) || null
  }, [activeRoom, rooms])

  const { startRotation, stopRotation, handleKeyRotationMessage, decryptWithRotation } =
    useKeyRotation({ keyRef: activeKeyRef, clientRef, room: activeRoom, appendMessage: (msg) => appendMessageToRoom(activeRoom, msg) })

  const { typingText, sendTypingIndicator, handleTypingMessage, clearTyping } =
    useTypingIndicator({ clientRef, room: activeRoom, nickname })

  const {
    uploadProgress, downloadProgress,
    fileInputRef, canvasRef,
    initAssembler, destroyAssembler, handleMediaChunk,
    handleFileSelect, handleCanvasShare, resetProgress,
  } = useMediaTransfer({ clientRef, keyRef: activeKeyRef, room: activeRoom, appendMessage: (msg) => appendMessageToRoom(activeRoom, msg) })

  // Generate QR code when share link changes for active room
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

  function getClient() {
    if (!clientRef.current) {
      clientRef.current = new TrapChatClient()
    }
    return clientRef.current
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [rooms, activeRoom])

  // Cleanup on unmount
  useEffect(() => {
    const meshes = peerMeshRef.current
    return () => {
      unsubsRef.current.forEach(fn => fn())
      unsubsRef.current = []
      stopRotation()
      destroyAssembler()
      if (clientRef.current) {
        clientRef.current.disconnect()
        clientRef.current = null
      }
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }
      for (const mesh of meshes.values()) {
        mesh.closeAll()
      }
    }
  }, [stopRotation, destroyAssembler])

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

  // Handle visualViewport resize for mobile keyboard
  useEffect(() => {
    if (!window.visualViewport) return
    const handleResize = () => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    window.visualViewport.addEventListener('resize', handleResize)
    return () => window.visualViewport.removeEventListener('resize', handleResize)
  }, [])

  const handleInputChange = useCallback((e) => {
    const value = e.target.value
    updateRoomState(activeRoom, (s) => ({ ...s, input: value }))
    if (value) {
      sendTypingIndicator(true)
    }
  }, [activeRoom, sendTypingIndicator, updateRoomState])

  // Create a PeerConnection signal sender for a given room and remote peer
  const makeSignalSender = useCallback((room, remotePeerId) => {
    return (signalPayload) => {
      const msg = JSON.stringify({
        id: crypto.randomUUID(), type: 'signal', room,
        to: remotePeerId, payload: JSON.stringify(signalPayload), timestamp: Date.now(),
      })
      const client = clientRef.current
      if (client?.connected) client.sendRaw(msg)
    }
  }, [])

  const handleJoinRoom = useCallback(async (e) => {
    e.preventDefault()
    const trimmed = joinRoom.trim()
    if (!trimmed || trimmed.length > MAX_ROOM_NAME_LEN) return

    // Check max rooms
    if (rooms.size >= MAX_ROOMS && !rooms.has(trimmed)) {
      alert(`Max ${MAX_ROOMS} rooms — leave one first`)
      return
    }

    const client = getClient()
    intentionalDisconnectRef.current = false

    try {
      setStatus('connecting')

      // Key setup
      let key = keyRefs.current.get(trimmed)
      let shareLink = ''
      if (typeof key === 'string' && key) {
        key = await importKey(key)
        keyRefs.current.set(trimmed, key)
        history.replaceState(null, '', window.location.pathname)
      } else if (passphrase.trim()) {
        key = await deriveRoomKey(trimmed, passphrase)
        keyRefs.current.set(trimmed, key)
      } else if (!key) {
        key = await generateRoomKey()
        keyRefs.current.set(trimmed, key)
        const exported = await exportKey(key)
        shareLink = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(trimmed)}/${exported}`
        history.replaceState(null, '', window.location.pathname)
      }

      // Connect if not already connected
      if (!client.connected) {
        await client.connect()
      }
      setStatus('connected')

      // Initialize room state
      updateRoomState(trimmed, (s) => ({
        ...s,
        shareLink: shareLink || s.shareLink,
      }))

      // Set up message handler if this is the first room
      if (rooms.size === 0 && unsubsRef.current.length === 0) {
        setupGlobalHandlers(client)
      }

      // Set up IntersectionObserver for read receipts
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const msgId = entry.target.dataset.msgId
              if (msgId) {
                client.send('receipt', activeRoomRef.current, JSON.stringify({ messageId: msgId, status: 'read' }))
                observerRef.current.unobserve(entry.target)
              }
            }
          })
        }, { threshold: 0.5 })
      }

      const jpObj = {}
      if (nickname.trim()) jpObj.nickname = nickname.trim()
      if (ttl > 0) jpObj.ttlSeconds = ttl
      const joinPayload = Object.keys(jpObj).length > 0 ? JSON.stringify(jpObj) : null
      client.send('join', trimmed, joinPayload)

      setActiveRoom(trimmed)
      setView('chat')
      setShowJoinModal(false)
      setPassphrase('')
    } catch (err) {
      setStatus('error')
      console.error('connection failed:', err)
    }
  }, [joinRoom, passphrase, nickname, ttl, rooms, updateRoomState, setupGlobalHandlers])

  const setupGlobalHandlers = useCallback((client) => {
    unsubsRef.current.forEach(fn => fn())
    unsubsRef.current = []

    startRotation(activeKeyRef.current)
    initAssembler()

    unsubsRef.current.push(client.on('message', async (data) => {
      if (typeof data !== 'object') return
      const msgRoom = data.room

      if (data.type === 'welcome') {
        // Handled by TrapChatClient internally
      } else if (data.type === 'room_list') {
        // Server confirms joined rooms — no action needed
      } else if (data.type === 'presence') {
        try {
          const presence = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
          const room = presence.room || msgRoom
          if (!room) return

          setRooms(prev => {
            const next = new Map(prev)
            const current = next.get(room)
            if (!current) return prev
            next.set(room, {
              ...current,
              peerCount: presence.count || 0,
              peerNicknames: presence.peers || current.peerNicknames,
              expiresAt: presence.expiresAt || current.expiresAt,
            })
            return next
          })

          if (room === activeRoomRef.current && presence.peers) {
            peerNicknamesRef.current = presence.peers
          }

          // WebRTC mesh: manage P2P connections per room
          const count = presence.count || 0
          const prevCount = prevPeerCountRef.current.get(room) || 0
          prevPeerCountRef.current.set(room, count)

          if (count === 2 && prevCount !== 2) {
            const selfId = client.peerId
            const pids = presence.peers ? Object.keys(presence.peers) : []
            const remotePid = pids.find(pid => pid !== selfId)
            if (selfId && remotePid && selfId < remotePid) {
              setTimeout(async () => {
                if (peerMeshRef.current.has(room)) return
                const pc = new PeerConnection(
                  makeSignalSender(room, remotePid),
                  (msgData) => {
                    try { client.emitP2P('message', { ...JSON.parse(msgData), room }) } catch { /* ignore parse errors */ }
                  }
                )
                pc.onConnected = () => {
                  updateRoomState(room, (s) => ({ ...s, isP2P: true }))
                }
                pc.onDisconnected = () => {
                  updateRoomState(room, (s) => ({ ...s, isP2P: false }))
                }
                // Store as a simple map entry (not PeerMesh for 2-peer case)
                const mesh = new PeerMesh({
                  onMessage: (pid, d) => {
                    try { client.emitP2P('message', { ...JSON.parse(d), room }) } catch { /* ignore parse errors */ }
                  },
                  onConnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: true })),
                  onDisconnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: false })),
                  onTrack: (pid, stream) => {
                    setRemoteStreams(prev => new Map(prev).set(pid, stream))
                  },
                })
                peerMeshRef.current.set(room, mesh)
                try {
                  await mesh.addPeer(remotePid, makeSignalSender(room, remotePid), true)
                } catch (err) {
                  console.error('WebRTC offer failed:', err)
                  peerMeshRef.current.delete(room)
                }
              }, 500)
            }
          } else if (count !== 2 && peerMeshRef.current.has(room)) {
            peerMeshRef.current.get(room).closeAll()
            peerMeshRef.current.delete(room)
            updateRoomState(room, (s) => ({ ...s, isP2P: false }))
          }
        } catch {
          // ignore malformed presence
        }
      } else if (data.type === 'signal') {
        try {
          const signalData = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
          const room = msgRoom

          let mesh = peerMeshRef.current.get(room)
          if (!mesh) {
            mesh = new PeerMesh({
              onMessage: (pid, d) => {
                try { client.emitP2P('message', { ...JSON.parse(d), room }) } catch { /* ignore parse errors */ }
              },
              onConnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: true })),
              onDisconnected: () => updateRoomState(room, (s) => ({ ...s, isP2P: false })),
              onTrack: (pid, stream) => {
                setRemoteStreams(prev => new Map(prev).set(pid, stream))
              },
            })
            peerMeshRef.current.set(room, mesh)
          }

          if (signalData.signalType === 'offer') {
            await mesh.addPeer(data.id, makeSignalSender(room, data.id), false)
            await mesh.handleSignal(data.id, signalData)
          } else {
            await mesh.handleSignal(data.id, signalData)
          }
        } catch (err) {
          console.error('WebRTC signal handling error:', err)
        }
      } else if (data.type === 'typing') {
        if (msgRoom === activeRoomRef.current) {
          handleTypingMessage(data)
        }
      } else if (data.type === 'receipt') {
        try {
          const rp = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
          if (rp.messageId && rp.status && msgRoom) {
            setRooms(prev => {
              const next = new Map(prev)
              const current = next.get(msgRoom)
              if (!current) return prev
              if (current.messageReceipts[rp.messageId] === 'read') return prev
              next.set(msgRoom, {
                ...current,
                messageReceipts: { ...current.messageReceipts, [rp.messageId]: rp.status }
              })
              return next
            })
          }
        } catch {
          // ignore
        }
      } else if (data.type === 'chat') {
        const room = msgRoom
        if (!room) return
        const roomKey = keyRefs.current.get(room)
        let text
        try {
          if (roomKey) {
            // Use the room-specific key for decryption
            const { decrypt } = await import('./lib/crypto.js')
            text = await decrypt(roomKey, data.payload)
          } else {
            text = await decryptWithRotation(data.payload)
          }
          if (text.length > MAX_TEXT_LENGTH) {
            text = text.slice(0, MAX_TEXT_LENGTH) + '... [truncated]'
          }
        } catch {
          text = '[encrypted message — key mismatch]'
        }
        const msgId = data.msgId || crypto.randomUUID()

        // Get nicknames for this room
        const roomState = rooms.get(room) || {}
        const nicknames = roomState.peerNicknames || peerNicknamesRef.current

        appendMessageToRoom(room, {
          id: msgId,
          text,
          time: new Date().toLocaleTimeString(),
          error: text === '[encrypted message — key mismatch]',
          senderId: data.id,
          senderNickname: nicknames[data.id] || (data.id ? data.id.slice(0, 8) : ''),
        })
        client.send('receipt', room, JSON.stringify({ messageId: msgId, status: 'delivered' }))
      } else if (data.type === 'key_rotation') {
        await handleKeyRotationMessage(data)
      } else if (data.type === 'media') {
        await handleMediaChunk(data)
      } else if (data.type === 'call_offer') {
        // Incoming call — show notification (auto-accept for now)
        const room = msgRoom
        if (!callActive && room) {
          handleIncomingCall(data.id, room, data.payload)
        }
      } else if (data.type === 'call_end') {
        endCall()
      }
    }))

    unsubsRef.current.push(client.on('close', () => {
      if (intentionalDisconnectRef.current) {
        setStatus('disconnected')
      } else {
        setStatus('reconnecting')
      }
    }))

    unsubsRef.current.push(client.on('reconnecting', ({ attempt }) => {
      setStatus(`reconnecting (attempt ${attempt})`)
    }))

    unsubsRef.current.push(client.on('open', () => {
      setStatus('connected')
    }))

    // Handle P2P data channel messages
    unsubsRef.current.push(client.on('p2p:message', async (data) => {
      if (typeof data !== 'object') return
      const room = data.room || activeRoomRef.current
      if (data.type === 'chat') {
        const roomKey = keyRefs.current.get(room)
        let text
        try {
          if (roomKey) {
            const { decrypt } = await import('./lib/crypto.js')
            text = await decrypt(roomKey, data.payload)
          } else {
            text = await decryptWithRotation(data.payload)
          }
          if (text.length > MAX_TEXT_LENGTH) {
            text = text.slice(0, MAX_TEXT_LENGTH) + '... [truncated]'
          }
        } catch {
          text = '[encrypted message — key mismatch]'
        }
        const msgId = data.msgId || crypto.randomUUID()
        appendMessageToRoom(room, {
          id: msgId,
          text,
          time: new Date().toLocaleTimeString(),
          error: text === '[encrypted message — key mismatch]',
          senderId: data.id,
          senderNickname: peerNicknamesRef.current[data.id] || (data.id ? data.id.slice(0, 8) : ''),
          p2p: true,
        })
      } else if (data.type === 'media') {
        handleMediaChunk(data)
      }
    }))
  }, [startRotation, initAssembler, handleTypingMessage, handleKeyRotationMessage, handleMediaChunk, decryptWithRotation, appendMessageToRoom, updateRoomState, makeSignalSender, rooms, callActive, endCall, handleIncomingCall])

  const handleIncomingCall = useCallback(async (fromPeerId, room, payloadStr) => {
    let type = 'audio'
    try {
      const p = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr
      type = p?.callType || 'audio'
    } catch { /* ignore malformed payload */ }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      })
      setLocalStream(stream)
      setCallActive(true)
      setCallType(type)

      // Add stream to mesh
      const mesh = peerMeshRef.current.get(room)
      if (mesh) {
        await mesh.broadcastStream(stream)
      }

      // Send call_answer
      const client = clientRef.current
      if (client?.connected) {
        client.send('call_answer', room, JSON.stringify({ callType: type }))
      }
    } catch (err) {
      console.error('Failed to get media for call:', err)
    }
  }, [])

  const startCall = useCallback(async (type) => {
    if (callActive || !activeRoom) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      })
      setLocalStream(stream)
      setCallActive(true)
      setCallType(type)

      // Send call_offer to room
      const client = clientRef.current
      if (client?.connected) {
        client.send('call_offer', activeRoom, JSON.stringify({ callType: type }))
      }

      // Add stream to mesh
      const mesh = peerMeshRef.current.get(activeRoom)
      if (mesh) {
        await mesh.broadcastStream(stream)
      }
    } catch (err) {
      console.error('Failed to start call:', err)
    }
  }, [callActive, activeRoom])

  const endCall = useCallback(() => {
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop())
      setLocalStream(null)
    }

    // Remove streams from all meshes
    for (const mesh of peerMeshRef.current.values()) {
      mesh.removeAllStreams()
    }

    // Send call_end
    const client = clientRef.current
    if (client?.connected && activeRoom) {
      client.send('call_end', activeRoom, null)
    }

    setCallActive(false)
    setCallType(null)
    setRemoteStreams(new Map())
    setCallMuted(false)
    setCallVideoOff(false)
  }, [localStream, activeRoom])

  const toggleMute = useCallback(() => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        setCallMuted(!audioTrack.enabled)
      }
    }
  }, [localStream])

  const toggleVideo = useCallback(() => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        setCallVideoOff(!videoTrack.enabled)
      }
    }
  }, [localStream])

  const sendMessage = useCallback(async (e) => {
    e.preventDefault()
    const currentState = rooms.get(activeRoom)
    if (!currentState?.input?.trim()) return

    const client = getClient()
    sendTypingIndicator(false)

    const roomKey = keyRefs.current.get(activeRoom)
    if (!roomKey) return

    let encrypted
    try {
      encrypted = await encrypt(roomKey, currentState.input)
    } catch (err) {
      console.error('encryption failed:', err)
      appendMessageToRoom(activeRoom, {
        id: crypto.randomUUID(),
        text: '[failed to encrypt message]',
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
      return
    }
    const msgId = crypto.randomUUID()
    // Try P2P first
    let sent = false
    const mesh = peerMeshRef.current.get(activeRoom)
    if (mesh) {
      const peers = mesh.connectedPeers
      if (peers.length > 0) {
        try {
          const p2pMsg = JSON.stringify({
            id: crypto.randomUUID(), msgId, type: 'chat', room: activeRoom, payload: encrypted, timestamp: Date.now(),
          })
          const conn = mesh.getConnection(peers[0])
          if (conn) sent = conn.send(p2pMsg)
        } catch {
          sent = false
        }
      }
    }
    if (!sent) {
      sent = client.send('chat', activeRoom, encrypted, { msgId })
    }

    appendMessageToRoom(activeRoom, {
      id: msgId,
      text: currentState.input,
      time: new Date().toLocaleTimeString(),
      own: true,
      queued: !sent,
    })
    updateRoomState(activeRoom, (s) => ({ ...s, input: '' }))
  }, [activeRoom, rooms, appendMessageToRoom, updateRoomState, sendTypingIndicator])

  const leaveRoom = useCallback((roomName) => {
    const room = roomName || activeRoom
    const client = getClient()

    client.send('leave', room, null)

    // Cleanup P2P for this room
    const mesh = peerMeshRef.current.get(room)
    if (mesh) {
      mesh.closeAll()
      peerMeshRef.current.delete(room)
    }
    prevPeerCountRef.current.delete(room)
    keyRefs.current.delete(room)

    // Remove room from state
    setRooms(prev => {
      const next = new Map(prev)
      next.delete(room)
      return next
    })

    // If leaving the active room, switch to another or go to join view
    if (room === activeRoom) {
      const remainingRooms = [...rooms.keys()].filter(r => r !== room)
      if (remainingRooms.length > 0) {
        setActiveRoom(remainingRooms[0])
      } else {
        // Last room — full cleanup
        intentionalDisconnectRef.current = true
        client.disconnect()
        destroyAssembler()
        stopRotation()
        unsubsRef.current.forEach(fn => fn())
        unsubsRef.current = []
        if (observerRef.current) {
          observerRef.current.disconnect()
          observerRef.current = null
        }
        setView('join')
        setActiveRoom('')
        setNickname('')
        setTtl(0)
        setStatus('disconnected')
        resetProgress()
        clearTyping()
        window.location.hash = ''
      }
    }
  }, [activeRoom, rooms, destroyAssembler, stopRotation, clearTyping, resetProgress])

  const switchRoom = useCallback((roomName) => {
    setActiveRoom(roomName)
    // Clear unread count
    updateRoomState(roomName, (s) => ({ ...s, unreadCount: 0 }))
    // Sync keyRef for hooks
    activeKeyRef.current = keyRefs.current.get(roomName) || null
  }, [updateRoomState])

  // Set local video element when stream changes
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  if (view === 'join') {
    return (
      <JoinView
        room={joinRoom} setRoom={setJoinRoom}
        nickname={nickname} setNickname={setNickname}
        passphrase={passphrase} setPassphrase={setPassphrase}
        ttl={ttl} setTtl={setTtl}
        onJoin={handleJoinRoom} status={status}
      />
    )
  }

  const currentRoomState = getRoomState(activeRoom)
  const roomNames = [...rooms.keys()]

  return (
    <ChatView
      room={activeRoom}
      rooms={roomNames}
      activeRoom={activeRoom}
      onSwitchRoom={switchRoom}
      onAddRoom={() => { setJoinRoom(''); setShowJoinModal(true) }}
      onLeaveRoom={leaveRoom}
      status={status}
      peerCount={currentRoomState.peerCount}
      peerNicknames={currentRoomState.peerNicknames}
      expiresAt={currentRoomState.expiresAt}
      p2p={currentRoomState.isP2P}
      messages={currentRoomState.messages}
      input={currentRoomState.input}
      onInputChange={handleInputChange}
      onSend={sendMessage}
      onLeave={() => leaveRoom(activeRoom)}
      shareLink={currentRoomState.shareLink}
      copied={currentRoomState.copied}
      onCopyShareLink={copyShareLink}
      showQR={currentRoomState.showQR}
      qrDataURL={currentRoomState.qrDataURL}
      onToggleQR={() => updateRoomState(activeRoom, (s) => ({ ...s, showQR: !s.showQR }))}
      uploadProgress={uploadProgress}
      downloadProgress={downloadProgress}
      typingText={typingText}
      messageReceipts={currentRoomState.messageReceipts}
      fileInputRef={fileInputRef}
      canvasRef={canvasRef}
      bottomRef={bottomRef}
      observerRef={observerRef}
      onFileSelect={handleFileSelect}
      onCanvasShare={handleCanvasShare}
      unreadCounts={Object.fromEntries([...rooms.entries()].map(([name, s]) => [name, s.unreadCount || 0]))}
      showJoinModal={showJoinModal}
      joinModalProps={{
        room: joinRoom, setRoom: setJoinRoom,
        nickname, setNickname,
        passphrase, setPassphrase,
        ttl, setTtl,
        onJoin: handleJoinRoom, status,
        isModal: true,
        onClose: () => setShowJoinModal(false),
      }}
      callActive={callActive}
      callType={callType}
      remoteStreams={remoteStreams}
      onStartCall={startCall}
      onEndCall={endCall}
      onToggleMute={toggleMute}
      onToggleVideo={toggleVideo}
      callMuted={callMuted}
      callVideoOff={callVideoOff}
      localVideoRef={localVideoRef}
    />
  )
}

export default App
