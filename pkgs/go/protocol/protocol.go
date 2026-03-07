package protocol

// MessageType represents the set of valid envelope types.
type MessageType string

const (
	TypeJoin     MessageType = "join"
	TypeLeave    MessageType = "leave"
	TypeChat     MessageType = "chat"
	TypeMedia    MessageType = "media"
	TypePresence MessageType = "presence"
	TypeError    MessageType = "error"
)

// Envelope is the wire format for all WebSocket messages.
type Envelope struct {
	ID        string      `json:"id"`
	Type      MessageType `json:"type"`
	Room      string      `json:"room"`
	Payload   string      `json:"payload,omitempty"`
	Timestamp int64       `json:"timestamp"`
	Sig       string      `json:"sig,omitempty"` // server-side AES-GCM signature for integrity verification
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
