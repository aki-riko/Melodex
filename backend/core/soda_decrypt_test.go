package core

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"math/bits"
	"testing"
)

func TestDecryptSodaAudioRestoresEncryptedSamples(t *testing.T) {
	hexKey := "00112233445566778899aabbccddeeff"
	playAuth := encodeSodaPlayAuthForTest(t, hexKey)
	if extracted, err := extractSodaKey(playAuth); err != nil || extracted != hexKey {
		t.Fatalf("extractSodaKey() = %q, %v", extracted, err)
	}

	key := []byte{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff}
	plainSamples := [][]byte{[]byte("first-audio-sample"), []byte("second-sample")}
	iv8 := [][]byte{{1, 2, 3, 4, 5, 6, 7, 8}, {8, 7, 6, 5, 4, 3, 2, 1}}
	encryptedSamples := make([][]byte, len(plainSamples))
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	for index, sample := range plainSamples {
		encryptedSamples[index] = append([]byte(nil), sample...)
		iv := make([]byte, aes.BlockSize)
		copy(iv, iv8[index])
		cipher.NewCTR(block, iv).XORKeyStream(encryptedSamples[index], encryptedSamples[index])
	}

	stszData := make([]byte, 12+len(plainSamples)*4)
	binary.BigEndian.PutUint32(stszData[8:12], uint32(len(plainSamples)))
	for index, sample := range plainSamples {
		binary.BigEndian.PutUint32(stszData[12+index*4:16+index*4], uint32(len(sample)))
	}
	sencData := make([]byte, 8)
	binary.BigEndian.PutUint32(sencData[4:8], uint32(len(iv8)))
	for _, iv := range iv8 {
		sencData = append(sencData, iv...)
	}
	stbl := testMP4Box("stbl", bytes.Join([][]byte{
		testMP4Box("stsd", []byte("metadata-enca-entry")),
		testMP4Box("stsz", stszData),
		testMP4Box("senc", sencData),
	}, nil))
	moov := testMP4Box("moov", testMP4Box("trak", testMP4Box("mdia", testMP4Box("minf", stbl))))
	mdat := testMP4Box("mdat", bytes.Join(encryptedSamples, nil))
	encryptedFile := append(moov, mdat...)

	decrypted, err := DecryptSodaAudio(encryptedFile, playAuth)
	if err != nil {
		t.Fatal(err)
	}
	mdatBox, ok := findMP4Box(decrypted, "mdat", 0, len(decrypted))
	if !ok {
		t.Fatal("decrypted file has no mdat")
	}
	if got, want := decrypted[mdatBox.dataStart:mdatBox.end], bytes.Join(plainSamples, nil); !bytes.Equal(got, want) {
		t.Fatalf("decrypted payload = %x, want %x", got, want)
	}
	if bytes.Contains(decrypted, []byte("enca")) || !bytes.Contains(decrypted, []byte("mp4a")) {
		t.Fatal("encrypted sample entry was not converted to mp4a")
	}
}

func encodeSodaPlayAuthForTest(t *testing.T, hexKey string) string {
	t.Helper()
	plain := []byte("0" + hexKey)
	encoded := make([]byte, len(plain))
	for index, target := range plain {
		mask := byte(0xfa)
		if index == 1 {
			mask = 0x55
		} else if index >= 2 {
			mask = encoded[index-2]
		}
		found := false
		for candidate := 0; candidate <= 255; candidate++ {
			value := int(byte(candidate)^mask) - bits.OnesCount32(uint32(index)) - 21
			for value < 0 {
				value += 255
			}
			if byte(value) == target {
				encoded[index] = byte(candidate)
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("cannot encode play auth byte %d", index)
		}
	}
	first := byte(48) ^ encoded[0] ^ encoded[1]
	return base64.StdEncoding.EncodeToString(append([]byte{first}, encoded...))
}

func testMP4Box(boxType string, payload []byte) []byte {
	box := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(box[:4], uint32(len(box)))
	copy(box[4:8], boxType)
	copy(box[8:], payload)
	return box
}
