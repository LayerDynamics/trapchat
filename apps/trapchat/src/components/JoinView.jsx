const MAX_ROOM_NAME_LEN = 64

export default function JoinView({ room, setRoom, nickname, setNickname, passphrase, setPassphrase, ttl, setTtl, onJoin, status }) {
  return (
    <div className="container" role="main">
      <h1>trapchat</h1>
      <p className="subtitle">anonymous. ephemeral. encrypted.</p>
      <form onSubmit={onJoin} className="join-form" aria-label="Join a chat room">
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
          type="text"
          value={nickname}
          onChange={(e) => setNickname(e.target.value.slice(0, 32))}
          placeholder="nickname (optional)"
          aria-label="Nickname"
          maxLength={32}
        />
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="passphrase (optional)"
          aria-label="Room passphrase"
        />
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
        <button type="submit">join</button>
      </form>
      <p className="status" aria-live="polite">{status}</p>
    </div>
  )
}
