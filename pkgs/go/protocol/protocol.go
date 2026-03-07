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
	TypeTyping      MessageType = "typing"
	TypeReceipt     MessageType = "receipt"
	TypeKeyRotation MessageType = "key_rotation"
)

// Envelope is the wire format for all WebSocket messages.
type Envelope struct {
	ID        string      `json:"id"`
	MsgID     string      `json:"msgId,omitempty"` // client-generated message ID, preserved through gateway for receipts
	Type      MessageType `json:"type"`
	Room      string      `json:"room"`
	Payload   string      `json:"payload,omitempty"`
	Timestamp int64       `json:"timestamp"`
	Sig       string      `json:"sig,omitempty"` // server-side HMAC-SHA256 signature for integrity verification
}

// ChatPayload is the decrypted inner payload for chat messages.
type ChatPayload struct {
	Text      string `json:"text"`
	Encrypted bool   `json:"encrypted"`
}

// PresencePayload reports room occupancy.
type PresencePayload struct {
	Room  string            `json:"room"`
	Count int               `json:"count"`
	Peers map[string]string `json:"peers,omitempty"` // peerID → nickname
}

// TypingPayload indicates typing state.
type TypingPayload struct {
	Typing   bool   `json:"typing"`
	Nickname string `json:"nickname,omitempty"`
}

// ReceiptPayload reports message delivery/read status.
type ReceiptPayload struct {
	MessageID string `json:"messageId"`
	Status    string `json:"status"` // "delivered" or "read"
}

// JoinPayload carries optional metadata when joining a room.
type JoinPayload struct {
	Nickname string `json:"nickname,omitempty"`
}
