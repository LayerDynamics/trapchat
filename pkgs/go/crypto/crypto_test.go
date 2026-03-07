package crypto

import (
	"bytes"
	"testing"
)

func TestEncryptDecryptRoundtrip(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("hello world")
	ct, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	pt, err := Decrypt(key, ct)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pt, plaintext) {
		t.Errorf("expected %q, got %q", plaintext, pt)
	}
}

func TestEncryptDecryptEmpty(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	ct, err := Encrypt(key, []byte{})
	if err != nil {
		t.Fatal(err)
	}
	pt, err := Decrypt(key, ct)
	if err != nil {
		t.Fatal(err)
	}
	if len(pt) != 0 {
		t.Errorf("expected empty, got %q", pt)
	}
}

func TestInvalidKeySize(t *testing.T) {
	_, err := Encrypt([]byte("short"), []byte("data"))
	if err != ErrInvalidKeySize {
		t.Errorf("expected ErrInvalidKeySize, got %v", err)
	}
	_, err = Decrypt([]byte("short"), []byte("data"))
	if err != ErrInvalidKeySize {
		t.Errorf("expected ErrInvalidKeySize, got %v", err)
	}
}

func TestDecryptTamperedCiphertext(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	ct, err := Encrypt(key, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	// Flip a byte in the ciphertext
	ct[len(ct)-1] ^= 0xff
	_, err = Decrypt(key, ct)
	if err == nil {
		t.Error("expected error for tampered ciphertext")
	}
}

func TestDecryptTooShort(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	_, err = Decrypt(key, []byte{1, 2, 3})
	if err != ErrCiphertextTooShort {
		t.Errorf("expected ErrCiphertextTooShort, got %v", err)
	}
}

func TestSignHMACDeterministic(t *testing.T) {
	key := []byte("test-key-exactly-32-bytes-long!!")
	sig1 := SignHMAC(key, "a", "b", "c")
	sig2 := SignHMAC(key, "a", "b", "c")
	if !bytes.Equal(sig1, sig2) {
		t.Error("HMAC should be deterministic")
	}
}

func TestSignHMACDifferentInputs(t *testing.T) {
	key := []byte("test-key-exactly-32-bytes-long!!")
	sig1 := SignHMAC(key, "a", "b")
	sig2 := SignHMAC(key, "ab", "")
	if bytes.Equal(sig1, sig2) {
		t.Error("different field splits should produce different HMACs (length-prefixed)")
	}
}

func TestSignHMACDelimiterInjection(t *testing.T) {
	key := []byte("test-key-exactly-32-bytes-long!!")
	// These would collide with pipe-delimited "a|b" vs "a" + "b"
	sig1 := SignHMAC(key, "a|b", "c")
	sig2 := SignHMAC(key, "a", "b|c")
	if bytes.Equal(sig1, sig2) {
		t.Error("pipe in payload should not cause collision")
	}
}

func TestVerifyHMAC(t *testing.T) {
	key := []byte("test-key-exactly-32-bytes-long!!")
	sig := SignHMAC(key, "field1", "field2")
	if !VerifyHMAC(key, sig, "field1", "field2") {
		t.Error("valid signature should verify")
	}
	if VerifyHMAC(key, sig, "field1", "tampered") {
		t.Error("tampered fields should not verify")
	}
}
