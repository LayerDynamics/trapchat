import { useState, useEffect, useRef, useCallback } from 'react'
import QRCode from 'qrcode'
import { TrapChatClient } from './socket/client.js'
import { generateRoomKey, exportKey, importKey, encrypt, decrypt, deriveRoomKey, KeyRotator } from './lib/crypto.js'
import { sendMedia, sendCanvas, MediaAssembler } from './lib/media.js'
import './App.css'

const MAX_MESSAGES = 500
const MAX_ROOM_NAME_LEN = 64
const ACCEPTED_FILE_TYPES = 'image/*,video/*,application/pdf'

function App() {
  const [view, setView] = useState('join')
  const [room, setRoom] = useState('')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [peerCount, setPeerCount] = useState(0)
  const [status, setStatus] = useState('disconnected')
  const keyRef = useRef(null)
  const bottomRef = useRef(null)
  const unsubsRef = useRef([])
  const clientRef = useRef(null)
  const [passphrase, setPassphrase] = useState('')
  const [shareLink, setShareLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [showQR, setShowQR] = useState(false)
  const [qrDataURL, setQrDataURL] = useState('')
  const [uploadProgress, setUploadProgress] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(null)
  const fileInputRef = useRef(null)
  const canvasRef = useRef(null)
  const assemblerRef = useRef(null)
  const rotatorRef = useRef(null)
  // Track whether disconnect was intentional to avoid conflicting with reconnect
  const intentionalDisconnectRef = useRef(false)

  // Key rotation interval from env or default 30 minutes
  const KEY_ROTATION_INTERVAL = parseInt(import.meta.env.VITE_KEY_ROTATION_INTERVAL || '1800000', 10)

  // Generate QR code data URL when share link changes
  useEffect(() => {
    let cancelled = false

    if (shareLink) {
      QRCode.toDataURL(shareLink, { width: 200, margin: 2 })
        .then((url) => {
          if (!cancelled) {
            setQrDataURL(url)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setQrDataURL('')
          }
        })
    } else {
      // Synchronous reset is intentional — clearing derived state when source is empty
      setQrDataURL('') // eslint-disable-line react-hooks/set-state-in-effect
      setShowQR(false) // eslint-disable-line react-hooks/set-state-in-effect
    }

    return () => {
      cancelled = true
    }
  }, [shareLink])

  const copyShareLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select a temporary input
      const tmp = document.createElement('input')
      tmp.value = shareLink
      document.body.appendChild(tmp)
      tmp.select()
      document.execCommand('copy')
      document.body.removeChild(tmp)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareLink])

  // Append message and cap at MAX_MESSAGES to prevent unbounded growth
  const appendMessage = useCallback((msg) => {
    setMessages(prev => {
      const next = [...prev, msg]
      return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next
    })
  }, [])

  // Lazily create the client instance per component mount
  function getClient() {
    if (!clientRef.current) {
      clientRef.current = new TrapChatClient()
    }
    return clientRef.current
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      unsubsRef.current.forEach(fn => fn())
      unsubsRef.current = []
      if (rotatorRef.current) {
        rotatorRef.current.stop()
        rotatorRef.current = null
      }
      if (clientRef.current) {
        clientRef.current.disconnect()
        clientRef.current = null
      }
    }
  }, [])

  // Check URL fragment for room#key on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash.includes('/')) {
      const [roomName, keyFragment] = hash.split('/', 2)
      if (roomName && keyFragment) {
        setRoom(decodeURIComponent(roomName)) // eslint-disable-line react-hooks/set-state-in-effect
        // Store the fragment key to be used during join
        keyRef.current = keyFragment
      }
    }
  }, [])

  const joinRoom = useCallback(async (e) => {
    e.preventDefault()
    const trimmed = room.trim()
    if (!trimmed || trimmed.length > MAX_ROOM_NAME_LEN) return

    const client = getClient()
    intentionalDisconnectRef.current = false

    try {
      setStatus('connecting')
      // If a key fragment was provided via URL hash, import it
      // Otherwise, generate a random room key and build a shareable link
      if (typeof keyRef.current === 'string' && keyRef.current) {
        // Key fragment provided via URL hash — import it then clear from browser history
        keyRef.current = await importKey(keyRef.current)
        // Remove key from URL to prevent leaking via browser history/bookmarks
        history.replaceState(null, '', window.location.pathname)
      } else if (passphrase.trim()) {
        // Passphrase provided — derive a deterministic key from room + passphrase
        keyRef.current = await deriveRoomKey(room, passphrase)
      } else {
        // No shared key in URL — generate a random key and share via URL fragment
        const key = await generateRoomKey()
        keyRef.current = key
        const exported = await exportKey(key)
        const link = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(room)}/${exported}`
        setShareLink(link)
        // Set hash temporarily for share link, then clear to prevent key leaking via history/referrer
        history.replaceState(null, '', window.location.pathname)
      }
      await client.connect()
      setStatus('connected')

      // Remove previous listeners to prevent duplicates on rejoin
      unsubsRef.current.forEach(fn => fn())
      unsubsRef.current = []

      // Initialize key rotator for periodic key rotation
      if (rotatorRef.current) rotatorRef.current.stop()
      rotatorRef.current = new KeyRotator({
        interval: KEY_ROTATION_INTERVAL,
        onRotate: (newKey) => {
          keyRef.current = newKey
          appendMessage({
            id: crypto.randomUUID(),
            text: '[key rotated — encryption key updated]',
            time: new Date().toLocaleTimeString(),
            system: true,
          })
        },
      })
      rotatorRef.current.start(keyRef.current)

      // Initialize media assembler for receiving chunked files
      if (assemblerRef.current) assemblerRef.current.destroy()
      assemblerRef.current = new MediaAssembler({
        onProgress: (transferId, received, total) => {
          setDownloadProgress({ transferId, received, total })
          if (received === total) {
            setTimeout(() => setDownloadProgress(null), 500)
          }
        },
      })

      unsubsRef.current.push(client.on('message', async (data) => {
        if (typeof data === 'object' && data.type === 'presence') {
          try {
            const presence = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload
            setPeerCount(presence.count || 0)
          } catch {
            setPeerCount(data.count || 0)
          }
        } else if (typeof data === 'object' && data.type === 'chat') {
          let text
          try {
            // Use rotator to try current key, then fall back to previous key during rotation window
            text = rotatorRef.current
              ? await rotatorRef.current.decrypt(data.payload)
              : await decrypt(keyRef.current, data.payload)
          } catch {
            text = '[encrypted message — key mismatch]'
          }
          appendMessage({
            id: crypto.randomUUID(),
            text,
            time: new Date().toLocaleTimeString(),
            error: text === '[encrypted message — key mismatch]',
          })
        } else if (typeof data === 'object' && data.type === 'media') {
          const result = await assemblerRef.current.handleChunk(data, keyRef.current)
          if (!result) return
          if (result.error) {
            appendMessage({
              id: crypto.randomUUID(),
              text: result.message,
              time: new Date().toLocaleTimeString(),
              error: true,
            })
          } else if (result.complete) {
            appendMessage({
              id: crypto.randomUUID(),
              time: new Date().toLocaleTimeString(),
              media: {
                url: result.url,
                mimeType: result.mimeType,
                fileName: result.fileName,
                fileSize: result.fileSize,
              },
            })
          }
        }
      }))

      unsubsRef.current.push(client.on('close', () => {
        // Only reset to join view if the user intentionally disconnected.
        // Unexpected closes are handled by the client's reconnect logic.
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
        // Covers both initial connect and successful reconnect
        setStatus('connected')
      }))

      client.send('join', room, null)
      setView('chat')
    } catch (err) {
      setStatus('error')
      console.error('connection failed:', err)
    }
  }, [room, passphrase, appendMessage])

  const sendMessage = useCallback(async (e) => {
    e.preventDefault()
    if (!input.trim()) return

    const client = getClient()
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
    const sent = client.send('chat', room, encrypted)

    appendMessage({
      id: crypto.randomUUID(),
      text: input,
      time: new Date().toLocaleTimeString(),
      own: true,
      queued: !sent,
    })
    setInput('')
  }, [input, room, appendMessage])

  const handleFileSelect = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // reset for re-selection

    const client = getClient()
    try {
      setUploadProgress({ sent: 0, total: 1 })
      const result = await sendMedia(client, keyRef.current, room, file, (sent, total) => {
        setUploadProgress({ sent, total })
      })
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        own: true,
        media: {
          url: URL.createObjectURL(file),
          mimeType: result.mimeType,
          fileName: result.fileName,
          fileSize: file.size,
        },
      })
    } catch (err) {
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        text: `[upload failed: ${err.message}]`,
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
    }
  }, [room, appendMessage])

  const handleCanvasShare = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const client = getClient()
    try {
      setUploadProgress({ sent: 0, total: 1 })
      const result = await sendCanvas(client, keyRef.current, room, canvas, (sent, total) => {
        setUploadProgress({ sent, total })
      })
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString(),
        own: true,
        media: {
          url: canvas.toDataURL('image/png'),
          mimeType: result.mimeType,
          fileName: result.fileName,
          fileSize: result.fileSize,
        },
      })
    } catch (err) {
      setUploadProgress(null)
      appendMessage({
        id: crypto.randomUUID(),
        text: `[canvas share failed: ${err.message}]`,
        time: new Date().toLocaleTimeString(),
        own: true,
        error: true,
      })
    }
  }, [room, appendMessage])

  const leaveRoom = useCallback(() => {
    const client = getClient()
    intentionalDisconnectRef.current = true
    unsubsRef.current.forEach(fn => fn())
    unsubsRef.current = []
    client.send('leave', room, null)
    client.disconnect()
    if (assemblerRef.current) {
      assemblerRef.current.destroy()
      assemblerRef.current = null
    }
    if (rotatorRef.current) {
      rotatorRef.current.stop()
      rotatorRef.current = null
    }
    setView('join')
    setMessages([])
    setRoom('')
    setStatus('disconnected')
    setShareLink('')
    setUploadProgress(null)
    setDownloadProgress(null)
    window.location.hash = ''
  }, [room])

  if (view === 'join') {
    return (
      <div className="container" role="main">
        <h1>trapchat</h1>
        <p className="subtitle">anonymous. ephemeral. encrypted.</p>
        <form onSubmit={joinRoom} className="join-form" aria-label="Join a chat room">
          <input
            type="text"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="enter room name"
            aria-label="Room name"
            maxLength={MAX_ROOM_NAME_LEN}
            autoFocus
          />
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="passphrase (optional)"
            aria-label="Room passphrase"
          />
          <button type="submit">join</button>
        </form>
        <p className="status" aria-live="polite">{status}</p>
      </div>
    )
  }

  return (
    <div className="container chat-container" role="main">
      <header className="chat-header">
        <span className={`status-dot ${status === 'connected' ? 'green' : status.startsWith('reconnecting') ? 'yellow' : 'red'}`} aria-label={`Connection status: ${status}`} />
        <span className="room-name">#{room}</span>
        <span className="peer-count" aria-live="polite">{peerCount} online</span>
        <button onClick={leaveRoom} className="leave-btn" aria-label="Leave room">leave</button>
      </header>
      {shareLink && (
        <div className="share-section">
          <button
            type="button"
            className={`share-bar ${copied ? 'copied' : ''}`}
            onClick={copyShareLink}
            aria-label="Copy share link to clipboard"
          >
            {copied ? 'copied!' : 'share link (click to copy)'}
          </button>
          {qrDataURL && (
            <button
              type="button"
              className="qr-toggle"
              onClick={() => setShowQR(prev => !prev)}
              aria-label={showQR ? 'Hide QR code' : 'Show QR code'}
            >
              {showQR ? 'hide QR' : 'show QR'}
            </button>
          )}
          {showQR && qrDataURL && (
            <div className="qr-container">
              <img src={qrDataURL} alt="Room share QR code" className="qr-code" />
            </div>
          )}
        </div>
      )}
      {uploadProgress && (
        <div className="upload-progress">
          <div className="upload-progress-bar" style={{ width: `${(uploadProgress.sent / uploadProgress.total) * 100}%` }} />
          <span className="upload-progress-text">sending {uploadProgress.sent}/{uploadProgress.total} chunks</span>
        </div>
      )}
      {downloadProgress && (
        <div className="download-progress">
          <div className="download-progress-bar" style={{ width: `${(downloadProgress.received / downloadProgress.total) * 100}%` }} />
          <span className="download-progress-text">receiving {downloadProgress.received}/{downloadProgress.total} chunks</span>
        </div>
      )}
      <div className="messages" role="log" aria-live="polite" aria-label="Chat messages">
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.own ? 'own' : ''} ${msg.error ? 'error' : ''} ${msg.queued ? 'queued' : ''}`}>
            {msg.media ? (
              <div className="media-preview">
                {msg.media.mimeType.startsWith('image/') ? (
                  <img src={msg.media.url} alt={msg.media.fileName} />
                ) : msg.media.mimeType.startsWith('video/') ? (
                  <video src={msg.media.url} controls preload="metadata" />
                ) : (
                  <a href={msg.media.url} download={msg.media.fileName} className="media-download">
                    {msg.media.fileName} ({(msg.media.fileSize / 1024).toFixed(1)}KB)
                  </a>
                )}
                <span className="media-filename">{msg.media.fileName}</span>
              </div>
            ) : (
              <span className="msg-text">{msg.text}</span>
            )}
            {msg.queued && <span className="msg-queued" aria-label="Message queued">queued</span>}
            <span className="msg-time">{msg.time}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <canvas ref={canvasRef} width={400} height={300} className="share-canvas" />
      <form onSubmit={sendMessage} className="send-form" aria-label="Send a message">
        <input
          type="file"
          ref={fileInputRef}
          accept={ACCEPTED_FILE_TYPES}
          onChange={handleFileSelect}
          hidden
        />
        <button type="button" className="attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach file">+</button>
        <button type="button" className="canvas-btn" onClick={handleCanvasShare} aria-label="Share canvas">canvas</button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="type a message..."
          aria-label="Message text"
          autoFocus
        />
        <button type="submit">send</button>
      </form>
    </div>
  )
}

export default App
