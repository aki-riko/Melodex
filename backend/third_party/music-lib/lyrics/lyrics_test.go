package lyrics

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestQRCDESMatchesReferenceImplementation(t *testing.T) {
	cipher, err := hex.DecodeString("00112233445566778899aabbccddeeff")
	if err != nil {
		t.Fatal(err)
	}

	got := hex.EncodeToString(append(
		qrcTripleDESDecrypt(cipher[:8]),
		qrcTripleDESDecrypt(cipher[8:])...,
	))
	const want = "3f706d43d53196a860bb351710e55957"
	if got != want {
		t.Fatalf("qrc decrypt = %s, want reference output %s", got, want)
	}
}

func TestDecryptQRCHexFromRealQQResponse(t *testing.T) {
	const encrypted = "0D1E3785DDA4AFCC84C79270A58311704E1F1718E2B6A4C3A71FFF7CB6DB0E6316DA3A79DB2F15D3E415B339E9582FF55B5E60183FCE1167AB99D0AAC7656C4BB08AA9DA11F11D5210D87581EDA3CF2430DE95B356B4FB2DC20BC16D748653A02B026919C7A0DD74509F3CCDCE3C0E54A44F1A481A4471F798903FA3AF40191444BB4A6FA2E75818C6A9EADE45334454B59AF1A16069E935E097E48C534F89EDB46457FEBC80C6E248A87A14E9C7F6748DA6CC1FFC795326FDDA86C53B9CFB6754CA09C055367D12009352736E6A8413C4D20FAC5B63C8A00008ED0E25AC5CD645591633439745FEC640C1103D3181586A96B69857E96EB07FE268B0A14B88C1EE9A72E5E18FD158F5A1718D2058A311BB85C8FD3D530C836C6F37AA930C82AFB8AE74086761DF19B6A87AA6CAE721FC4A47430E1CDB063F096EEF901D88F7BA2C66065BA8B20322E06198352E1CA0D1C5A03034E4E1D6A2B10BD04FE112651401560733D1BB679D3D084A8A0F4F5E95A3C2C6766259248506FE69086B48186187B6468569F0379A9E2C0050A4467169EAF65B3F4ED108F173D9682D532E1AD18BD811057011E0EB792D0D6515FE3BBB5949663144CA99251323CFDA8CA93AAB46996B090F1D69F76EB0852C7593D08728075AA731391F5FB6D4AA0308C8B4060901924E4C0E77DF6785E27D690350EA79D74294709C4B5444BB9410ED1E443594961212E2A9B0B4620DF2901E3F7E73977275C5FF81D4932023E5D89A4B143B7D5D9D1F2138DFA31EDB855E200B56A86C6C0EA4627CFCD77FD20C5595EE1D8436BABD60E561168CEAE3183D4F12C7236B6F34A8479F7249BC5FE3E9405DEE6F792CD4BFDC948C1DC4244A4154C328B8C7C9CFC6C17DFC732A32D1071386F2F26660F1B2871ACD79E481F63DDBED1807B351566F6C4AED95FFBC4C9A697B482E783D16AB6F275A3C7B63E38A2AC091BED59AEDF044AA5FCEF266F0447898F0C82E9C8504D23FF8B6F907CA3280036C808F39C8E5B42CD34DD8131DF879DF0F2DD43ACA26E6BCDA362E98E0ECFB5DEF30C6562AB0898226F9A3D21A7918118DCE7D91E93AA4F059B2376C30A11EA8F284628AF7CDC6EE6F941D45661438B94D6A7CA9FDE5EA700A8DC47F33A831F2DE2994EA657A63CA1E541665552CF2E6CC138EE35AA63D7B0733DD961EEF2E6789E9F4EC7713A2AAF94ED48C4340CDF5A38D59C77EF8185C24B01AE1ACC17CE8F9251542EF6A098BE1882C0CA226E6CD651FB2992521545F4D99CEC569BC77D0E25193D810C58C0D03DEB0772392B50F5F1F"

	got, err := DecryptQRCHex(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"[00:01.23]演唱：婴戏浅戈", "如初见", "迟来花信"} {
		if !strings.Contains(got, want) {
			t.Fatalf("decrypted qrc missing %q: %.200s", want, got)
		}
	}
}

func TestParseYRCAndConvertVerbatimLRC(t *testing.T) {
	orig := ParseYRC("[1000,1000](1000,500,0)你(1500,500,0)好\n[2500,800](2500,800,0)世界")
	_, ts := ParseLRC("[00:01.00]hello\n[00:02.50]world")
	_, roma := ParseLRC("[00:01.00]ni hao\n[00:02.50]shi jie")

	got := ConvertVerbatimLRC(map[string]string{"ti": "song"}, MultiData{
		"orig": orig,
		"ts":   ts,
		"roma": roma,
	}, DefaultDisplayOrder())

	for _, want := range []string{
		"[ti:song]",
		"[00:01.00]你[00:01.50]好[00:02.00]",
		"[00:01.00]ni hao[00:02.00]",
		"[00:01.00]hello[00:02.00]",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("converted lrc missing %q:\n%s", want, got)
		}
	}

	if strings.Index(got, "ni hao") > strings.Index(got, "hello") {
		t.Fatalf("romaji should be emitted before translation:\n%s", got)
	}
}

func TestConvertVerbatimLRCMapsExtraTracksByTimestampBeforeIndex(t *testing.T) {
	orig := ParseYRC("[0,200](0,200,0)作词\n[980,1000](980,500,0)家まで(1480,500,0)送って")
	_, ts := ParseLRC("[00:00.98]希望你能送我回家")
	_, roma := ParseLRC("[00:00.98]ie made okutte")

	got := ConvertVerbatimLRC(nil, MultiData{
		"orig": orig,
		"ts":   ts,
		"roma": roma,
	}, DefaultDisplayOrder())

	for _, wrong := range []string{
		"[00:00.00][00:00.98]ie made okutte",
		"[00:00.00][00:00.98]希望你能送我回家",
		"[00:00.00]ie made okutte",
		"[00:00.00]希望你能送我回家",
	} {
		if strings.Contains(got, wrong) {
			t.Fatalf("extra tracks were incorrectly paired by index:\n%s", got)
		}
	}
	if strings.Count(got, "ie made okutte") != 1 || strings.Count(got, "希望你能送我回家") != 1 {
		t.Fatalf("extra tracks were incorrectly paired by index:\n%s", got)
	}
	for _, want := range []string{
		"[00:00.00]作词[00:00.20]",
		"[00:00.98]家まで[00:01.48]送って[00:01.98]",
		"[00:00.98]ie made okutte[00:01.98]",
		"[00:00.98]希望你能送我回家[00:01.98]",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("converted lrc missing %q:\n%s", want, got)
		}
	}
}

func TestParseQRC(t *testing.T) {
	raw := `<Lyric_1 LyricType="1" LyricContent="[ti:T]&#10;[1000,1000]你(1000,500)好(1500,500)"/>`
	tags, data := ParseQRC(raw)
	if tags["ti"] != "T" {
		t.Fatalf("tag ti = %q", tags["ti"])
	}
	if len(data) != 1 || len(data[0].Words) != 2 {
		t.Fatalf("unexpected qrc data: %#v", data)
	}
	if data[0].Words[1].Text != "好" || data[0].Words[1].End.MS != 2000 {
		t.Fatalf("unexpected second word: %#v", data[0].Words[1])
	}
}

func TestParseKRCWithLanguage(t *testing.T) {
	languageJSON := `{"content":[{"type":0,"lyricContent":[["ni","hao"]]},{"type":1,"lyricContent":[["hello"]]}]}`
	language := base64.StdEncoding.EncodeToString([]byte(languageJSON))
	raw := "[language:" + language + "]\n[1000,1000]<0,500,0>你<500,500,0>好"

	tags, data := ParseKRC(raw)
	if tags["language"] == "" {
		t.Fatal("missing language tag")
	}
	if data["roma"][0].Words[1].Text != "hao" {
		t.Fatalf("unexpected roma: %#v", data["roma"])
	}
	if data["ts"][0].Words[0].Text != "hello" {
		t.Fatalf("unexpected translation: %#v", data["ts"])
	}
}

func TestDecryptKRC(t *testing.T) {
	plain := "[1000,1000]<0,1000,0>Hi"
	var compressed bytes.Buffer
	zw := zlib.NewWriter(&compressed)
	if _, err := zw.Write([]byte(plain)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}

	encrypted := append([]byte("krc1"), compressed.Bytes()...)
	for i := 4; i < len(encrypted); i++ {
		encrypted[i] ^= krcKey[(i-4)%len(krcKey)]
	}

	got, err := DecryptKRC(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if got != plain {
		t.Fatalf("got %q, want %q", got, plain)
	}
}
