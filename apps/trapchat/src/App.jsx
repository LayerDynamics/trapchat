import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import { TrapChatClient } from './socket/client.js'
import { generateRoomKey, exportKey, importKey, encrypt, deriveRoomKey } from './lib/crypto.js'
import { useKeyRotation } from './hooks/useKeyRotation.js'
import { useTypingIndicator } from './hooks/useTypingIndicator.js'
import { useMediaTransfer } from './hooks/useMediaTransfer.js'
import JoinView from './components/JoinView.jsx'
import ChatView from './components/ChatView.jsx'
import './App.css'

const MAX_MESSAGES = 500
const MAX_ROOM_NAME_LEN = 64

function App() {
  const [view, setView] = useState('join')
  const [room, setRoom] = useState(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName] = hash.split('/', 2)
      if (roomName) return decodeURIComponent(roomName)
    }
    return ''
  })
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [peerCount, setPeerCount] = useState(0)
  const [status, setStatus] = useState('disconnected')
  const [nickname, setNickname] = useState('')
  const [peerNicknames, setPeerNicknames] = useState({})
  const peerNicknamesRef = useRef({})
  const [messageReceipts, setMessageReceipts] = useState({})
  const keyRef = useRef(null)
  const bottomRef = useRef(null)
  const unsubsRef = useRef([])
  const clientRef = useRef(null)
  const [passphrase, setPassphrase] = useState('')
  const [shareLink, setShareLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [qrDataURL, setQrDataURL] = useState('')
  const intentionalDisconnectRef = useRef(false)
  const observerRef = useRef(null)

  const appendMessage = useCallback((msg) => {
    setMessages(prev => {
      const next = [...prev, msg]
      if (next.length > MAX_MESSAGES) {
        const evicted = next.slice(0, next.length - MAX_MESSAGES)
        // Revoke object URLs from evicted media messages to prevent memory leaks
        for (const m of evicted) {
          if (m.media?.url && m.media.url.startsWith('blob:')) {
            URL.revokeObjectURL(m.media.url)
          }
        }
        return next.slice(next.length - MAX_MESSAGES)
      }
      return next
    })
  }, [])

  const { startRotation, stopRotation, handleKeyRotationMessage, decryptWithRotation } =
    useKeyRotation({ keyRef, clientRef, room, appendMessage })

  const { typingText, sendTypingIndicator, handleTypingMessage, clearTyping } =
    useTypingIndicator({ clientRef, room, nickname })

  const {
    uploadProgress, downloadProgress,
    fileInputRef, canvasRef,
    initAssembler, destroyAssembler, handleMediaChunk,
    handleFileSelect, handleCanvasShare, resetProgress,
  } = useMediaTransfer({ clientRef, keyRef, room, appendMessage })

  // Generate QR code data URL when share link changes
  useEffect(() => {
    if (!shareLink) return
    let cancelled = false
    QRCode.toDataURL(shareLink, { width: 200, margin: 2 })
      .then((url) => { if (!cancelled) setQrDataURL(url) })
      .catch(() => { if (!cancelled) setQrDataURL('') })
    return () => {
      cancelled = true
      setQrDataURL('')
      setShowQR(false)
    }
  }, [shareLink])

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: create a temporary textarea and use the clipboard API via user activation
      const textarea = document.createElement('textarea')
      textarea.value = shareLink
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        // Use Selection + clipboard API where available, fall back to execCommand
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(shareLink)
        } else {
          document.execCommand('copy')
        }
      } catch {
        document.execCommand('copy')
      }
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareLink])

  function getClient() {
    if (!clientRef.current) {
      clientRef.current = new TrapChatClient()
    }
    return clientRef.current
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Cleanup on unmount
  useEffect(() => {
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
    }
  }, [stopRotation, destroyAssembler])

  // Check URL fragment for key on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName, keyFragment] = hash.split('/', 2)
      if (roomName && keyFragment) {
        keyRef.current = keyFragment
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
    setInput(e.target.value)
    if (e.target.value) {
      sendTypingIndicator(true)
    }
  }, [sendTypingIndicator])

  const joinRoom = useCallback(async (e) => {
    e.preventDefault()
    const trimmed = room.trim()
    if (!trimmed || trimmed.length > MAX_ROOM_NAME_LEN) return

    const client = getClient()
    intentionalDisconnectRef.current = false

    try {
      setStatus('connecting')
      if (typeof keyRef.current === 'string' && keyRef.current) {
        keyRef.current = await importKey(keyRef.current)
        history.replaceState(null, '', window.location.pathname)
      } else if (passphrase.trim()) {
        keyRef.current = await deriveRoomKey(room, passphrase)
      } else {
        const key = await generateRoomKey()
        keyRef.current = key
        const exported = await exportKey(key)
        const link = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(room)}/${exported}`
        setShareLink(link)
        history.replaceState(null, '', window.location.pathname)
      }
      await client.connect()
      setStatus('connected')

      unsubsRef.current.forEach(fn => fn())
      unsubsRef.current = []

      startRotation(keyRef.current)
      initAssembler()

      // Set up IntersectionObserver for read receipts
      if (observerRef.current) observerRef.current.disconnect()
      observerRef.current = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const msgId = entry.target.dataset.msgId
            if (msgId) {
              client.send('receipt', room, JSON.stringify({ messageId: msgId, status: 'read' }))
              observerRef.current.unobserve(entry.target)
            }
          }
        })
      }, { threshold: 0.5 })

      unsubsRef.current.push(client.on('message', async (data) => {
        if (typeof data === 'object' && data.type === 'presence') {
          try {
            const presence = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
            setPeerCount(presence.count || 0)
            if (presence.peers) {
              peerNicknamesRef.current = presence.peers
              setPeerNicknames(presence.peers)
            }
          } catch {
            setPeerCount(data.count || 0)
          }
        } else if (typeof data === 'object' && data.type === 'typing') {
          handleTypingMessage(data)
        } else if (typeof data === 'object' && data.type === 'receipt') {
          try {
            const rp = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
            if (rp.messageId && rp.status) {
              setMessageReceipts(prev => {
                const current = prev[rp.messageId]
                if (current === 'read') return prev
                return { ...prev, [rp.messageId]: rp.status }
              })
            }
          } catch {
            // ignore malformed receipt
          }
        } else if (typeof data === 'object' && data.type === 'chat') {
          let text
          try {
            text = await decryptWithRotation(data.payload)
          } catch {
            text = '[encrypted message — key mismatch]'
          }
          const msgId = data.msgId || crypto.randomUUID()
          appendMessage({
            id: msgId,
            text,
            time: new Date().toLocaleTimeString(),
            error: text === '[encrypted message — key mismatch]',
            senderId: data.id,
            senderNickname: peerNicknamesRef.current[data.id] || (data.id ? data.id.slice(0, 8) : ''),
          })
          client.send('receipt', room, JSON.stringify({ messageId: msgId, status: 'delivered' }))
        } else if (typeof data === 'object' && data.type === 'key_rotation') {
          await handleKeyRotationMessage(data)
        } else if (typeof data === 'object' && data.type === 'media') {
          await handleMediaChunk(data)
        }
      }))

      unsubsRef.current.push(client.on('close', () => {
        if (intentionalDisconnectRef.current) {
          setStatus('disconnected')
          setView('join')
          setMessages([])
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

      const joinPayload = nickname.trim() ? JSON.stringify({ nickname: nickname.trim() }) : null
      client.send('join', room, joinPayload)
      setView('chat')
    } catch (err) {
      setStatus('error')
      console.error('connection failed:', err)
    }
  }, [room, passphrase, nickname, appendMessage, startRotation, initAssembler, handleTypingMessage, handleKeyRotationMessage, handleMediaChunk, decryptWithRotation])

  const sendMessage = useCallback(async (e) => {
    e.preventDefault()
    if (!input.trim()) return

    const client = getClient()
    sendTypingIndicator(false)

    let encrypted
    try {
      encrypted = await encrypt(keyRef.current, input)
    } catch (err) {
      console.error('encryption failed:', err)
      appendMessage({
        id: crypto.randomUUID(),
        text: '[failed to encrypt message]',
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
      return
    }
    const msgId = crypto.randomUUID()
    const sent = client.send('chat', room, encrypted, { msgId })

    appendMessage({
      id: msgId,
      text: input,
      time: new Date().toLocaleTimeString(),
      own: true,
      queued: !sent,
    })
    setInput('')
  }, [input, room, appendMessage, sendTypingIndicator])

  const leaveRoom = useCallback(() => {
    const client = getClient()
    intentionalDisconnectRef.current = true
    unsubsRef.current.forEach(fn => fn())
    unsubsRef.current = []
    client.send('leave', room, null)
    client.disconnect()
    destroyAssembler()
    stopRotation()
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    clearTyping()
    setView('join')
    setMessages([])
    setRoom('')
    setNickname('')
    peerNicknamesRef.current = {}
    setPeerNicknames({})
    setMessageReceipts({})
    setStatus('disconnected')
    setShareLink('')
    resetProgress()
    window.location.hash = ''
  }, [room, destroyAssembler, stopRotation, clearTyping, resetProgress])

  if (view === 'join') {
    return (
      <JoinView
        room={room} setRoom={setRoom}
        nickname={nickname} setNickname={setNickname}
        passphrase={passphrase} setPassphrase={setPassphrase}
        onJoin={joinRoom} status={status}
      />
    )
  }

  return (
    <ChatView
      room={room} status={status} peerCount={peerCount} peerNicknames={peerNicknames}
      messages={messages} input={input}
      onInputChange={handleInputChange} onSend={sendMessage} onLeave={leaveRoom}
      shareLink={shareLink} copied={copied} onCopyShareLink={copyShareLink}
      showQR={showQR} qrDataURL={qrDataURL} onToggleQR={() => setShowQR(prev => !prev)}
      uploadProgress={uploadProgress} downloadProgress={downloadProgress}
      typingText={typingText} messageReceipts={messageReceipts}
      fileInputRef={fileInputRef} canvasRef={canvasRef}
      bottomRef={bottomRef} observerRef={observerRef}
      onFileSelect={handleFileSelect} onCanvasShare={handleCanvasShare}
    />
  )
}

export default App
