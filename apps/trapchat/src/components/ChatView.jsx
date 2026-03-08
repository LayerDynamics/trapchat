import { useState, useEffect, useCallback } from 'react'
import JoinView from './JoinView.jsx'

const ACCEPTED_FILE_TYPES = 'image/*,video/*,application/pdf'

function useCanvasDrawing(canvasRef) {
  const getPos = useCallback((canvas, e) => {
    const rect = canvas.getBoundingClientRect()
    if (e.touches) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top }
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    ctx.strokeStyle = '#00ff41'
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    let drawing = false

    const start = (e) => {
      e.preventDefault()
      drawing = true
      const { x, y } = getPos(canvas, e)
      ctx.beginPath()
      ctx.moveTo(x, y)
    }

    const move = (e) => {
      if (!drawing) return
      e.preventDefault()
      const { x, y } = getPos(canvas, e)
      ctx.lineTo(x, y)
      ctx.stroke()
    }

    const stop = () => { drawing = false }

    canvas.addEventListener('mousedown', start)
    canvas.addEventListener('mousemove', move)
    canvas.addEventListener('mouseup', stop)
    canvas.addEventListener('mouseleave', stop)
    canvas.addEventListener('touchstart', start, { passive: false })
    canvas.addEventListener('touchmove', move, { passive: false })
    canvas.addEventListener('touchend', stop)

    return () => {
      canvas.removeEventListener('mousedown', start)
      canvas.removeEventListener('mousemove', move)
      canvas.removeEventListener('mouseup', stop)
      canvas.removeEventListener('mouseleave', stop)
      canvas.removeEventListener('touchstart', start)
      canvas.removeEventListener('touchmove', move)
      canvas.removeEventListener('touchend', stop)
    }
  }, [canvasRef, getPos])
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'expired'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function ChatView({
  room,
  rooms,
  activeRoom,
  onSwitchRoom,
  onAddRoom,
  onLeaveRoom,
  status,
  peerCount,
  peerNicknames,
  expiresAt,
  p2p,
  messages,
  input,
  onInputChange,
  onSend,
  onLeave,
  shareLink,
  copied,
  onCopyShareLink,
  showQR,
  qrDataURL,
  onToggleQR,
  uploadProgress,
  downloadProgress,
  typingText,
  messageReceipts,
  fileInputRef,
  canvasRef,
  bottomRef,
  observerRef,
  onFileSelect,
  onCanvasShare,
  unreadCounts,
  showJoinModal,
  joinModalProps,
  callActive,
  callType,
  localStream,
  remoteStreams,
  onStartCall,
  onEndCall,
  onToggleMute,
  onToggleVideo,
  callMuted,
  callVideoOff,
  localVideoRef,
}) {
  useCanvasDrawing(canvasRef)

  const [timeRemaining, setTimeRemaining] = useState(null)
  useEffect(() => {
    if (!expiresAt) {
      setTimeRemaining(null)
      return
    }
    const update = () => {
      const remaining = expiresAt - Date.now()
      setTimeRemaining(remaining)
      if (remaining <= 0) {
        clearInterval(id)
        onLeave()
      }
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [expiresAt, onLeave])

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
  }, [canvasRef])

  return (
    <div className="container chat-container" role="main">
      {/* Room tabs */}
      {rooms && rooms.length > 0 && (
        <div className="room-tabs">
          {rooms.map(r => (
            <button
              key={r}
              className={`room-tab ${r === activeRoom ? 'active' : ''}`}
              onClick={() => onSwitchRoom(r)}
            >
              #{r}
              {unreadCounts && unreadCounts[r] > 0 && r !== activeRoom && (
                <span className="unread-badge">{unreadCounts[r]}</span>
              )}
              <span
                className="room-tab-close"
                onClick={(e) => { e.stopPropagation(); onLeaveRoom(r) }}
                aria-label={`Leave room ${r}`}
              >&times;</span>
            </button>
          ))}
          <button className="room-tab add-room-tab" onClick={onAddRoom} aria-label="Join another room">+</button>
        </div>
      )}

      <header className="chat-header">
        <span className={`status-dot ${status === 'connected' ? 'green' : status.startsWith('reconnecting') ? 'yellow' : 'red'}`} aria-label={`Connection status: ${status}`} />
        <span className="room-name">#{room}</span>
        <span className="peer-count" aria-live="polite" title={peerNicknames && Object.values(peerNicknames).filter(Boolean).join(', ')}>{peerCount} online</span>
        {p2p && <span className="p2p-badge">p2p</span>}
        {timeRemaining !== null && <span className="ttl-countdown">{formatTimeRemaining(timeRemaining)}</span>}
        {!callActive && (
          <>
            <button onClick={() => onStartCall('audio')} className="call-btn" aria-label="Voice call" title="Voice call">&#127908;</button>
            <button onClick={() => onStartCall('video')} className="call-btn" aria-label="Video call" title="Video call">&#128249;</button>
          </>
        )}
        <button onClick={onLeave} className="leave-btn" aria-label="Leave room">leave</button>
      </header>

      {/* Call overlay */}
      {callActive && (
        <div className="call-overlay">
          <div className="call-videos">
            <video ref={localVideoRef} muted autoPlay playsInline className="local-video" />
            {[...remoteStreams.entries()].map(([peerId, stream]) => (
              <video
                key={peerId}
                autoPlay
                playsInline
                className="remote-video"
                ref={el => { if (el) el.srcObject = stream }}
              />
            ))}
            {remoteStreams.size === 0 && (
              <div className="call-waiting">waiting for others to join...</div>
            )}
          </div>
          <div className="call-controls">
            <button
              onClick={onToggleMute}
              className={`call-control-btn ${callMuted ? 'active' : ''}`}
              aria-label={callMuted ? 'Unmute' : 'Mute'}
            >
              {callMuted ? 'unmute' : 'mute'}
            </button>
            {callType === 'video' && (
              <button
                onClick={onToggleVideo}
                className={`call-control-btn ${callVideoOff ? 'active' : ''}`}
                aria-label={callVideoOff ? 'Turn on camera' : 'Turn off camera'}
              >
                {callVideoOff ? 'cam on' : 'cam off'}
              </button>
            )}
            <button onClick={onEndCall} className="call-control-btn end-call" aria-label="End call">
              end
            </button>
          </div>
        </div>
      )}

      {shareLink && (
        <div className="share-section">
          <button
            type="button"
            className={`share-bar ${copied ? 'copied' : ''}`}
            onClick={onCopyShareLink}
            aria-label="Copy share link to clipboard"
          >
            {copied ? 'copied!' : 'share link (click to copy)'}
          </button>
          {qrDataURL && (
            <button
              type="button"
              className="qr-toggle"
              onClick={onToggleQR}
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
          <div
            key={msg.id}
            className={`message ${msg.own ? 'own' : ''} ${msg.error ? 'error' : ''} ${msg.queued ? 'queued' : ''}`}
            data-msg-id={msg.id}
            ref={(el) => {
              if (el && !msg.own && observerRef.current) {
                observerRef.current.observe(el)
              }
            }}
          >
            {!msg.own && !msg.system && msg.senderNickname && (
              <span className="msg-sender">{msg.senderNickname}</span>
            )}
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
            {msg.own && (
              <span className="msg-receipt">
                {messageReceipts[msg.id] === 'read' ? '\u2713\u2713' : '\u2713'}
              </span>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {typingText && (
        <div className="typing-indicator" aria-live="polite">{typingText}</div>
      )}
      <canvas ref={canvasRef} width={400} height={300} className="share-canvas" style={{ cursor: 'crosshair' }} />
      <button type="button" className="canvas-clear-btn" onClick={clearCanvas} aria-label="Clear canvas">clear</button>
      <form onSubmit={onSend} className="send-form" aria-label="Send a message">
        <input
          type="file"
          ref={fileInputRef}
          accept={ACCEPTED_FILE_TYPES}
          onChange={onFileSelect}
          hidden
        />
        <button type="button" className="attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Attach file">+</button>
        <button type="button" className="canvas-btn" onClick={onCanvasShare} aria-label="Share canvas">canvas</button>
        <input
          type="text"
          value={input}
          onChange={onInputChange}
          placeholder="type a message..."
          aria-label="Message text"
          autoFocus
        />
        <button type="submit">send</button>
      </form>

      {/* Join room modal */}
      {showJoinModal && joinModalProps && (
        <div className="join-modal-backdrop" onClick={joinModalProps.onClose}>
          <div className="join-modal" onClick={e => e.stopPropagation()}>
            <JoinView {...joinModalProps} />
          </div>
        </div>
      )}
    </div>
  )
}
