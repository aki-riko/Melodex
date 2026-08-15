package core

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/bits"
	"strings"
)

// DecryptSodaAudio ports the Spade/AES-CTR algorithm from the pinned
// CharlesPikachu/musicdl Apache-2.0 snapshot.
func DecryptSodaAudio(encrypted []byte, playAuth string) ([]byte, error) {
	hexKey, err := extractSodaKey(playAuth)
	if err != nil {
		return nil, err
	}
	key, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("decode soda key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create soda cipher: %w", err)
	}

	output := append([]byte(nil), encrypted...)
	moov, ok := findMP4Box(output, "moov", 0, len(output))
	if !ok {
		return nil, errors.New("soda audio has no moov box")
	}
	trak, ok := findMP4Box(output, "trak", moov.dataStart, moov.end)
	if !ok {
		return nil, errors.New("soda audio has no trak box")
	}
	mdia, ok := findMP4Box(output, "mdia", trak.dataStart, trak.end)
	if !ok {
		return nil, errors.New("soda audio has no mdia box")
	}
	minf, ok := findMP4Box(output, "minf", mdia.dataStart, mdia.end)
	if !ok {
		return nil, errors.New("soda audio has no minf box")
	}
	stbl, ok := findMP4Box(output, "stbl", minf.dataStart, minf.end)
	if !ok {
		return nil, errors.New("soda audio has no stbl box")
	}
	stsz, ok := findMP4Box(output, "stsz", stbl.dataStart, stbl.end)
	if !ok {
		return nil, errors.New("soda audio has no stsz box")
	}
	sampleSizes, err := parseSodaSampleSizes(output[stsz.dataStart:stsz.end])
	if err != nil {
		return nil, err
	}

	senc, ok := findMP4Box(output, "senc", moov.dataStart, moov.end)
	if !ok {
		senc, ok = findMP4Box(output, "senc", stbl.dataStart, stbl.end)
	}
	if !ok {
		return nil, errors.New("soda audio has no senc box")
	}
	ivs, err := parseSodaIVs(output[senc.dataStart:senc.end])
	if err != nil {
		return nil, err
	}
	mdat, ok := findMP4Box(output, "mdat", 0, len(output))
	if !ok {
		return nil, errors.New("soda audio has no mdat box")
	}

	readOffset := mdat.dataStart
	for index, size := range sampleSizes {
		if size < 0 || readOffset+size > mdat.end {
			return nil, errors.New("soda sample exceeds mdat payload")
		}
		if index < len(ivs) {
			stream := cipher.NewCTR(block, ivs[index])
			stream.XORKeyStream(output[readOffset:readOffset+size], output[readOffset:readOffset+size])
		}
		readOffset += size
	}
	if readOffset != mdat.end {
		return nil, errors.New("soda sample sizes do not cover mdat payload")
	}

	if stsd, found := findMP4Box(output, "stsd", stbl.dataStart, stbl.end); found {
		payload := output[stsd.start:stsd.end]
		if index := strings.Index(string(payload), "enca"); index >= 0 {
			copy(payload[index:index+4], "mp4a")
		}
	}
	return output, nil
}

func extractSodaKey(playAuth string) (string, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(playAuth))
	if err != nil {
		return "", fmt.Errorf("decode soda play auth: %w", err)
	}
	if len(decoded) < 3 {
		return "", errors.New("soda play auth is too short")
	}
	paddingLength := int(decoded[0]^decoded[1]^decoded[2]) - 48
	if paddingLength < 0 || len(decoded) < paddingLength+2 {
		return "", errors.New("soda play auth has invalid padding")
	}
	inner := decoded[1 : len(decoded)-paddingLength]
	plain := make([]byte, len(inner))
	buff := append([]byte{0xfa, 0x55}, inner...)
	for index := range plain {
		value := int(inner[index]^buff[index]) - bits.OnesCount32(uint32(index)) - 21
		for value < 0 {
			value += 255
		}
		plain[index] = byte(value)
	}
	if len(plain) == 0 {
		return "", errors.New("soda play auth has no key data")
	}
	skip, ok := decodeBase36Byte(plain[0])
	if !ok {
		return "", errors.New("soda play auth has invalid key prefix")
	}
	messageLength := len(decoded) - paddingLength - 2
	end := 1 + messageLength - skip
	if end <= 1 || end > len(plain) {
		return "", errors.New("soda play auth has invalid key length")
	}
	return string(plain[1:end]), nil
}

func decodeBase36Byte(value byte) (int, bool) {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0'), true
	case value >= 'a' && value <= 'z':
		return int(value-'a') + 10, true
	default:
		return 0, false
	}
}

type mp4Box struct {
	start     int
	dataStart int
	end       int
}

func findMP4Box(data []byte, boxType string, start, end int) (mp4Box, bool) {
	if start < 0 || end > len(data) || start > end {
		return mp4Box{}, false
	}
	for offset := start; offset+8 <= end; {
		size := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		if size < 8 || offset+size > end {
			return mp4Box{}, false
		}
		if string(data[offset+4:offset+8]) == boxType {
			return mp4Box{start: offset, dataStart: offset + 8, end: offset + size}, true
		}
		offset += size
	}
	return mp4Box{}, false
}

func parseSodaSampleSizes(data []byte) ([]int, error) {
	if len(data) < 12 {
		return nil, errors.New("soda stsz box is too short")
	}
	fixedSize := int(binary.BigEndian.Uint32(data[4:8]))
	count := int(binary.BigEndian.Uint32(data[8:12]))
	if count < 0 || count > 1_000_000 {
		return nil, errors.New("soda stsz sample count is invalid")
	}
	sizes := make([]int, count)
	if fixedSize != 0 {
		for index := range sizes {
			sizes[index] = fixedSize
		}
		return sizes, nil
	}
	if len(data) < 12+count*4 {
		return nil, errors.New("soda stsz entries are truncated")
	}
	for index := range sizes {
		sizes[index] = int(binary.BigEndian.Uint32(data[12+index*4 : 16+index*4]))
	}
	return sizes, nil
}

func parseSodaIVs(data []byte) ([][]byte, error) {
	if len(data) < 8 {
		return nil, errors.New("soda senc box is too short")
	}
	flags := binary.BigEndian.Uint32(data[:4]) & 0x00ffffff
	count := int(binary.BigEndian.Uint32(data[4:8]))
	if count < 0 || count > 1_000_000 {
		return nil, errors.New("soda senc sample count is invalid")
	}
	offset := 8
	ivs := make([][]byte, 0, count)
	for index := 0; index < count; index++ {
		if offset+8 > len(data) {
			return nil, errors.New("soda senc IV is truncated")
		}
		iv := make([]byte, aes.BlockSize)
		copy(iv, data[offset:offset+8])
		ivs = append(ivs, iv)
		offset += 8
		if flags&0x02 != 0 {
			if offset+2 > len(data) {
				return nil, errors.New("soda senc subsample count is truncated")
			}
			subsamples := int(binary.BigEndian.Uint16(data[offset : offset+2]))
			offset += 2 + subsamples*6
			if offset > len(data) {
				return nil, errors.New("soda senc subsamples are truncated")
			}
		}
	}
	return ivs, nil
}
