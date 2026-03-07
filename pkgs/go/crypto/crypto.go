package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
)

const keySize = 32 // AES-256

var (
	ErrCiphertextTooShort = errors.New("ciphertext too short")
	ErrInvalidKeySize     = errors.New("invalid key size, must be 32 bytes")
)

// GenerateKey creates a random 256-bit key for AES-256-GCM.
func GenerateKey() ([]byte, error) {
	key := make([]byte, keySize)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	return key, nil
}

// Encrypt encrypts plaintext using AES-256-GCM.
// Returns nonce prepended to ciphertext.
func Encrypt(key, plaintext []byte) ([]byte, error) {
	if len(key) != keySize {
		return nil, ErrInvalidKeySize
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// Decrypt decrypts AES-256-GCM ciphertext (nonce prepended).
func Decrypt(key, ciphertext []byte) ([]byte, error) {
	if len(key) != keySize {
		return nil, ErrInvalidKeySize
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := gcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, ErrCiphertextTooShort
	}

	nonce, ct := ciphertext[:nonceSize], ciphertext[nonceSize:]
	return gcm.Open(nil, nonce, ct, nil)
}

// SignHMAC computes an HMAC-SHA256 over fields using length-prefixed encoding
// to prevent delimiter injection attacks. Each field is prefixed with its
// byte length as a 4-byte big-endian uint32.
func SignHMAC(key []byte, fields ...string) []byte {
	mac := hmac.New(sha256.New, key)
	for _, f := range fields {
		b := []byte(f)
		var lenBuf [4]byte
		binary.BigEndian.PutUint32(lenBuf[:], uint32(len(b)))
		mac.Write(lenBuf[:])
		mac.Write(b)
	}
	return mac.Sum(nil)
}

// VerifyHMAC checks an HMAC-SHA256 signature against fields.
func VerifyHMAC(key, sig []byte, fields ...string) bool {
	expected := SignHMAC(key, fields...)
	return hmac.Equal(sig, expected)
}
