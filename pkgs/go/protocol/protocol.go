package protocol

const (
	TypeJoin     = "join"
	TypeLeave    = "leave"
	TypeChat     = "chat"
	TypeMedia    = "media"
	TypePresence = "presence"
	TypeError    = "error"
)

// Envelope is the wire format for all WebSocket messages.
type Envelope struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Room      string `json:"room"`
	Payload   string `json:"payload,omitempty"`
	Timestamp int64  `json:"timestamp"`
}

// ChatPayload is the decrypted inner payload for chat messages.
type ChatPayload struct {
	Text      string `json:"text"`
	Encrypted bool   `json:"encrypted"`
}

// PresencePayload reports room occupancy.
type PresencePayload struct {
	Room  string `json:"room"`
	Count int    `json:"count"`
}
