import { useState } from 'react'

const MAX_ROOM_NAME_LEN = 64

function FeatureCard({ icon, title, desc }) {
  return (
    <div className="feature-card">
      <span className="feature-icon">{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{desc}</p>
      </div>
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="how-it-works">
      <h2>how it works</h2>
      <div className="steps">
        <div className="step">
          <span className="step-num">1</span>
          <div>
            <strong>create or join a room</strong>
            <p>Enter any room name. If no one else is there yet, you created it. Share the room name or invite link with others.</p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">2</span>
          <div>
            <strong>messages are encrypted</strong>
            <p>A unique encryption key is generated for your room. Only people with the key can read messages. Use a passphrase for a shared secret, or share the auto-generated invite link.</p>
          </div>
        </div>
        <div className="step">
          <span className="step-num">3</span>
          <div>
            <strong>chat, call, share</strong>
            <p>Send text, images, files, or start voice/video calls. When two people are in a room, traffic goes peer-to-peer — never touching our servers.</p>
          </div>
        </div>
      </div>

      <h2>features</h2>
      <div className="features-grid">
        <FeatureCard
          icon="&#128274;"
          title="end-to-end encryption"
          desc="AES-GCM encryption with keys that never leave your device."
        />
        <FeatureCard
          icon="&#128257;"
          title="peer-to-peer"
          desc="When 2 users are in a room, data flows directly between browsers via WebRTC."
        />
        <FeatureCard
          icon="&#9202;"
          title="ephemeral rooms"
          desc="Set a time limit and the room self-destructs — no traces left behind."
        />
        <FeatureCard
          icon="&#127908;"
          title="voice &amp; video calls"
          desc="One-click voice or video calls with anyone in your room. No plugins needed."
        />
        <FeatureCard
          icon="&#128206;"
          title="file &amp; media sharing"
          desc="Send images, videos, and files — encrypted and chunked for large transfers."
        />
        <FeatureCard
          icon="&#128100;"
          title="no accounts"
          desc="No sign-up, no email, no phone number. Just pick a name and go."
        />
      </div>

      <div className="privacy-note">
        <strong>your privacy:</strong> no messages are stored on our servers. Encryption keys exist only in your browser.
        We cannot read your messages even if we wanted to. When you leave, it's gone.
      </div>
    </div>
  )
}

function PassphraseToggle({ passphrase, setPassphrase }) {
  const [showField, setShowField] = useState(false)

  if (!showField) {
    return (
      <button
        type="button"
        className="passphrase-toggle"
        onClick={() => setShowField(true)}
      >
        + add passphrase
      </button>
    )
  }

  return (
    <div className="passphrase-row">
      <input
        type="password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="enter shared passphrase"
        aria-label="Room passphrase"
        autoFocus
      />
      <button
        type="button"
        className="passphrase-remove"
        onClick={() => { setPassphrase(''); setShowField(false) }}
        aria-label="Remove passphrase"
        title="Remove"
      >&times;</button>
    </div>
  )
}

export default function JoinView({ room, setRoom, nickname, setNickname, passphrase, setPassphrase, ttl, setTtl, onJoin, status, isModal, onClose, onRandomizeName }) {
  return (
    <div className={isModal ? 'join-modal-inner' : 'container join-page'} role="main">
      {!isModal && <h1>trapchat</h1>}
      {!isModal && <p className="subtitle">anonymous. ephemeral. encrypted.</p>}
      {isModal && (
        <div className="join-modal-header">
          <h2>join another room</h2>
          <button type="button" className="join-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
      )}
      <form onSubmit={onJoin} className="join-form" aria-label="Join a chat room">
        <div className="room-name-row">
          <input
            type="text"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="enter room name"
            aria-label="Room name"
            maxLength={MAX_ROOM_NAME_LEN}
            autoFocus
          />
          {onRandomizeName && (
            <button type="button" className="randomize-btn" onClick={onRandomizeName} aria-label="Generate random room name" title="Random name">&#8635;</button>
          )}
        </div>
        <input
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value.slice(0, 32))}
          placeholder="nickname (optional)"
          aria-label="Nickname"
          maxLength={32}
        />
        <PassphraseToggle passphrase={passphrase} setPassphrase={setPassphrase} />
        <select
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
          aria-label="Room expiry"
          className="ttl-select"
        >
          <option value={0}>no expiry</option>
          <option value={900}>15 minutes</option>
          <option value={3600}>1 hour</option>
          <option value={14400}>4 hours</option>
          <option value={86400}>24 hours</option>
        </select>
        <button type="submit">join room</button>
      </form>
      {!isModal && <p className="form-hint">no account needed — hit join to start chatting instantly</p>}
      <p className="status" aria-live="polite">{status}</p>
      {!isModal && <HowItWorks />}
    </div>
  )
}
