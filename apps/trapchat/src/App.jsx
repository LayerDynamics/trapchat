import { useState, useEffect, useRef, useCallback } from 'react'
import { TrapChatClient } from './socket/client.js'
import { encrypt, decrypt, uint8ToBase64, base64ToUint8, deriveRoomKey, importKey } from './lib/crypto.js'
import { useRoomManager } from './hooks/useRoomManager.js'
import { useWebRTCMesh } from './hooks/useWebRTCMesh.js'
import { useCallManager } from './hooks/useCallManager.js'
import { useKeyRotation } from './hooks/useKeyRotation.js'
import { useTypingIndicator } from './hooks/useTypingIndicator.js'
import { useMediaTransfer } from './hooks/useMediaTransfer.js'
import JoinView from './components/JoinView.jsx'
import ChatView from './components/ChatView.jsx'
import './App.css'

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return await Notification.requestPermission()
}

const ADJECTIVES = [
  'swift', 'silent', 'shadow', 'neon', 'ghost', 'lunar', 'cosmic', 'cyber',
  'arctic', 'ember', 'crystal', 'iron', 'velvet', 'crimson', 'golden', 'hidden',
  'storm', 'frost', 'dark', 'wild', 'rogue', 'phantom', 'mystic', 'chrome',
  'atomic', 'blazing', 'hollow', 'vivid', 'ancient', 'static', 'turbo', 'solar',
]
const NOUNS = [
  'wolf', 'hawk', 'viper', 'fox', 'panther', 'cobra', 'raven', 'tiger',
  'falcon', 'lynx', 'orca', 'jaguar', 'phoenix', 'dragon', 'serpent', 'mantis',
  'spark', 'bolt', 'pulse', 'flare', 'drift', 'wave', 'blade', 'echo',
  'cipher', 'nexus', 'vertex', 'orbit', 'prism', 'wraith', 'spectre', 'sigma',
]

function secureRandom(max) {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return arr[0] % max
}

function generateRoomName() {
  const adj = ADJECTIVES[secureRandom(ADJECTIVES.length)]
  const noun = NOUNS[secureRandom(NOUNS.length)]
  const num = secureRandom(1000)
  return `${adj}-${noun}-${num}`
}

function generateNickname() {
  const adj = ADJECTIVES[secureRandom(ADJECTIVES.length)]
  const noun = NOUNS[secureRandom(NOUNS.length)]
  return `${adj}${noun.charAt(0).toUpperCase()}${noun.slice(1)}`
}

function App() {
  const [nickname, setNickname] = useState(generateNickname)
  const [showJoinModal, setShowJoinModal] = useState(false)
  const [joinRoom, setJoinRoom] = useState(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName] = hash.split('/', 2)
      if (roomName) return decodeURIComponent(roomName)
    }
    return generateRoomName()
  })
  const [passphrase, setPassphrase] = useState('')
  const [ttl, setTtl] = useState(0)

  const clientRef = useRef(null)
  const bottomRef = useRef(null)
  const unsubsRef = useRef([])
  const peerNicknamesRef = useRef({})
  const intentionalDisconnectRef = useRef(false)
  const observerRef = useRef(null)
  const pendingKeyRoomsRef = useRef(new Set()) // rooms currently re-deriving keys
  const pendingMessagesRef = useRef(new Map()) // room -> [{data}] queued during key derivation

  // --- Room Manager ---
  const {
    rooms, roomsRef, setRooms, activeRoom, setActiveRoom, view, setView,
    status, setStatus, keyRefs, activeKeyRef, activeRoomRef,
    saltRefs, passphraseRefs,
    getRoomState, updateRoomState, appendMessageToRoom,
    switchRoom, copyShareLink, setupRoomKey, removeRoom,
    MAX_ROOMS, MAX_ROOM_NAME_LEN, MAX_TEXT_LENGTH,
  } = useRoomManager()

  // --- Call Manager (initialized first for setRemoteStreams) ---
  const {
    callActive, callType, localStream, remoteStreams, setRemoteStreams,
    callMuted, callVideoOff, localVideoRef,
    startCall, endCall, handleIncomingCall,
    toggleMute, toggleVideo,
    peerMeshBridgeRef,
  } = useCallManager({ clientRef, activeRoom })
  const callActiveRef = useRef(callActive)
  callActiveRef.current = callActive

  // --- WebRTC Mesh ---
  const {
    peerMeshRef, makeSignalSender,
    handlePresenceMesh, handleSignal: handleWebRTCSignal,
    cleanupRoom: cleanupMeshRoom, cleanupAll: cleanupAllMeshes,
  } = useWebRTCMesh({ clientRef, updateRoomState, setRemoteStreams })

  // Bridge peerMeshRef into call manager
  peerMeshBridgeRef.current = peerMeshRef

  // --- Existing hooks ---
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
    const meshRef = peerMeshRef
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
      for (const mesh of meshRef.current.values()) {
        mesh.closeAll()
      }
    }
  }, [stopRotation, destroyAssembler, peerMeshRef])

  // Request microphone permission when entering chat view
  const hasRequestedMicRef = useRef(false)
  useEffect(() => {
    if (view === 'chat' && !hasRequestedMicRef.current) {
      hasRequestedMicRef.current = true
      setTimeout(() => {
        navigator.mediaDevices?.getUserMedia({ audio: true })
          .then(stream => stream.getTracks().forEach(t => t.stop()))
          .catch(() => {})
      }, 500)
    }
  }, [view])

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

  const endCallRef = useRef(null)
  const handleIncomingCallRef = useRef(null)
  endCallRef.current = endCall
  handleIncomingCallRef.current = handleIncomingCall

  const setupGlobalHandlersRef = useRef(null)

  const handleJoinRoom = useCallback(async (e) => {
    e.preventDefault()
    const trimmed = joinRoom.trim()
    if (!trimmed || trimmed.length > MAX_ROOM_NAME_LEN) return

    if (rooms.size >= MAX_ROOMS && !rooms.has(trimmed)) {
      alert(`Max ${MAX_ROOMS} rooms — leave one first`)
      return
    }

    const client = getClient()
    intentionalDisconnectRef.current = false

    try {
      setStatus('connecting')

      const { shareLink } = await setupRoomKey(trimmed, passphrase)

      if (!client.connected) {
        await client.connect()
      }
      setStatus('connected')

      updateRoomState(trimmed, (s) => ({
        ...s,
        shareLink: shareLink || s.shareLink,
      }))

      if (rooms.size === 0 && unsubsRef.current.length === 0) {
        setupGlobalHandlersRef.current(client)
      }

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
      // Include salt in join payload for passphrase-derived rooms
      const roomSalt = saltRefs.current.get(trimmed)
      if (roomSalt) jpObj.salt = uint8ToBase64(roomSalt)
      const joinPayload = Object.keys(jpObj).length > 0 ? JSON.stringify(jpObj) : null
      client.send('join', trimmed, joinPayload)

      requestNotificationPermission()

      setActiveRoom(trimmed)
      setView('chat')
      setShowJoinModal(false)
      setPassphrase('')
    } catch (err) {
      setStatus(`error: ${err.message || err}`)
      console.error('connection failed:', err)
    }
  }, [joinRoom, passphrase, nickname, ttl, rooms, updateRoomState, setupRoomKey, setStatus, setActiveRoom, setView, activeRoomRef, MAX_ROOM_NAME_LEN, MAX_ROOMS])

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
        // Server confirms joined rooms
      } else if (data.type === 'presence') {
        try {
          const presence = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
          const room = presence.room || msgRoom
          if (!room) return

          // Handle salt from presence: if the server returns a different salt
          // (room already existed with a salt from the first joiner), re-derive key
          if (presence.salt) {
            const serverSalt = base64ToUint8(presence.salt)
            const cachedSalt = saltRefs.current.get(room)
            const saltsMatch = cachedSalt && cachedSalt.length === serverSalt.length &&
              cachedSalt.every((b, i) => b === serverSalt[i])
            if (!saltsMatch) {
              const pp = passphraseRefs.current.get(room)
              if (pp) {
                // Mark room as pending key derivation — messages will be queued
                pendingKeyRoomsRef.current.add(room)
                saltRefs.current.set(room, serverSalt)
                const newKey = await deriveRoomKey(room, pp, serverSalt)
                keyRefs.current.set(room, newKey)
                if (room === activeRoomRef.current) {
                  activeKeyRef.current = newKey
                }
                // Clear passphrase after successful derivation (minimize exposure)
                passphraseRefs.current.delete(room)
                // Flush any messages that arrived during derivation
                pendingKeyRoomsRef.current.delete(room)
                const queued = pendingMessagesRef.current.get(room)
                if (queued && queued.length > 0) {
                  pendingMessagesRef.current.delete(room)
                  for (const qData of queued) {
                    // Re-emit queued messages for processing
                    client.emit('message', qData)
                  }
                }
              }
            }
          }

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

          // WebRTC mesh management
          const count = presence.count || 0
          await handlePresenceMesh(room, count, presence.peers, client.peerId)
        } catch {
          // ignore malformed presence
        }
      } else if (data.type === 'signal') {
        try {
          await handleWebRTCSignal(data, msgRoom)
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
        // Queue messages that arrive during key re-derivation
        if (pendingKeyRoomsRef.current.has(room)) {
          if (!pendingMessagesRef.current.has(room)) pendingMessagesRef.current.set(room, [])
          pendingMessagesRef.current.get(room).push(data)
          return
        }
        const msgId = await decryptAndAppendChat(data, room)
        client.send('receipt', room, JSON.stringify({ messageId: msgId, status: 'delivered' }))
      } else if (data.type === 'key_rotation') {
        const room = msgRoom
        if (!room) return
        const roomKey = keyRefs.current.get(room)
        if (room === activeRoomRef.current) {
          await handleKeyRotationMessage(data)
        } else if (roomKey) {
          try {
            const exportedNewKey = await decrypt(roomKey, data.payload)
            const newKey = await importKey(exportedNewKey)
            keyRefs.current.set(room, newKey)
            appendMessageToRoom(room, {
              id: crypto.randomUUID(),
              text: '[key rotated by peer — encryption key updated]',
              time: new Date().toLocaleTimeString(),
              system: true,
            })
          } catch {
            appendMessageToRoom(room, {
              id: crypto.randomUUID(),
              text: '[key rotation failed — could not decrypt new key]',
              time: new Date().toLocaleTimeString(),
              error: true,
            })
          }
        }
      } else if (data.type === 'media') {
        await handleMediaChunk(data)
      } else if (data.type === 'call_offer') {
        const room = msgRoom
        if (!callActiveRef.current && room) {
          handleIncomingCallRef.current(data.id, room, data.payload)
        }
      } else if (data.type === 'call_end') {
        endCallRef.current()
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

    // Shared decrypt-and-append logic for chat messages (WS and P2P)
    async function decryptAndAppendChat(data, room, opts = {}) {
      const roomKey = keyRefs.current.get(room)
      let text
      try {
        if (roomKey) {
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

      const roomState = roomsRef.current.get(room) || {}
      const nicknames = roomState.peerNicknames || peerNicknamesRef.current

      appendMessageToRoom(room, {
        id: msgId,
        text,
        time: new Date().toLocaleTimeString(),
        error: text === '[encrypted message — key mismatch]',
        senderId: data.id,
        senderNickname: nicknames[data.id] || (data.id ? data.id.slice(0, 8) : ''),
        ...opts,
      })
      return msgId
    }

    // Handle P2P data channel messages
    unsubsRef.current.push(client.on('p2p:message', async (data) => {
      if (typeof data !== 'object') return
      const room = data.room || activeRoomRef.current
      if (data.type === 'chat') {
        await decryptAndAppendChat(data, room, { p2p: true })
      } else if (data.type === 'media') {
        handleMediaChunk(data)
      }
    }))
  }, [startRotation, initAssembler, handleTypingMessage, handleKeyRotationMessage, handleMediaChunk, decryptWithRotation, appendMessageToRoom, updateRoomState, handlePresenceMesh, handleWebRTCSignal, setRooms, setStatus, activeRoomRef, keyRefs, roomsRef, MAX_TEXT_LENGTH])

  setupGlobalHandlersRef.current = setupGlobalHandlers

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
      ownNickname: nickname || null,
      queued: !sent,
    })
    updateRoomState(activeRoom, (s) => ({ ...s, input: '' }))
  }, [activeRoom, rooms, appendMessageToRoom, updateRoomState, sendTypingIndicator, keyRefs, peerMeshRef, nickname])

  const leaveRoom = useCallback((roomName) => {
    const room = roomName || activeRoom
    const client = getClient()

    client.send('leave', room, null)

    cleanupMeshRoom(room)
    removeRoom(room)

    if (room === activeRoom) {
      const remainingRooms = [...rooms.keys()].filter(r => r !== room)
      if (remainingRooms.length > 0) {
        setActiveRoom(remainingRooms[0])
      } else {
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
  }, [activeRoom, rooms, destroyAssembler, stopRotation, clearTyping, resetProgress, cleanupMeshRoom, removeRoom, setActiveRoom, setView, setStatus])

  if (view === 'join') {
    return (
      <JoinView
        room={joinRoom} setRoom={setJoinRoom}
        nickname={nickname} setNickname={setNickname}
        passphrase={passphrase} setPassphrase={setPassphrase}
        ttl={ttl} setTtl={setTtl}
        onJoin={handleJoinRoom} status={status}
        onRandomizeName={() => setJoinRoom(generateRoomName())}
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
      localStream={localStream}
    />
  )
}

export default App
