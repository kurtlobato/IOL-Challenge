package discovery

import "testing"

func TestEnabled_DefaultTrue(t *testing.T) {
	t.Setenv("LANFLIX_MDNS", "")
	if !Enabled() {
		t.Fatal("expected enabled by default")
	}
}

func TestEnabled_Off(t *testing.T) {
	t.Setenv("LANFLIX_MDNS", "0")
	if Enabled() {
		t.Fatal("expected disabled with 0")
	}
}

func TestParseListenPort(t *testing.T) {
	p, err := ParseListenPort(":8080")
	if err != nil || p != 8080 {
		t.Fatalf("got %d %v", p, err)
	}
}

func TestBuildTxt(t *testing.T) {
	txt := BuildTxt("n", "name", "v")
	if txt["nodeId"] != "n" || txt["name"] != "name" || txt["version"] != "v" {
		t.Fatalf("txt: %#v", txt)
	}
}

