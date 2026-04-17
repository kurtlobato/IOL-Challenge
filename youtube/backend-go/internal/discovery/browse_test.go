package discovery

import (
	"net"
	"testing"

	"github.com/grandcat/zeroconf"
)

func TestParseTxtRecords(t *testing.T) {
	t.Parallel()
	m := parseTxtRecords([]string{"nodeId=abc-123", "name=foo", "bad", "=nokey", "onlyvalue"})
	if m["nodeId"] != "abc-123" || m["name"] != "foo" {
		t.Fatalf("got %#v", m)
	}
	if _, ok := m["bad"]; ok {
		t.Fatal("expected skip bad line")
	}
}

func TestFormatHostPort(t *testing.T) {
	t.Parallel()
	ip := net.ParseIP("192.168.1.10")
	if formatHostPort(ip, 8080) != "192.168.1.10:8080" {
		t.Fatal(formatHostPort(ip, 8080))
	}
	ip6 := net.ParseIP("2001:db8::1")
	if formatHostPort(ip6, 9000) != "[2001:db8::1]:9000" {
		t.Fatal(formatHostPort(ip6, 9000))
	}
}

func TestPeerFromEntry(t *testing.T) {
	t.Parallel()
	e := &zeroconf.ServiceEntry{
		Port: 8080,
		Text: []string{"nodeId=peer-1", "name=x"},
	}
	e.AddrIPv4 = []net.IP{net.ParseIP("10.0.0.5")}
	base, id := peerFromEntry(e)
	if id != "peer-1" || base != "http://10.0.0.5:8080" {
		t.Fatalf("base=%q id=%q", base, id)
	}

	onlyLoopback := &zeroconf.ServiceEntry{
		Port:     8080,
		Text:     []string{"nodeId=x"},
		AddrIPv4: []net.IP{net.ParseIP("127.0.0.1")},
	}
	if b, _ := peerFromEntry(onlyLoopback); b != "" {
		t.Fatalf("expected skip loopback-only addr, got %q", b)
	}
}

func TestPickServiceIPSkipsLoopbackIPv4(t *testing.T) {
	t.Parallel()
	e := &zeroconf.ServiceEntry{
		AddrIPv4: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("192.168.0.2")},
	}
	ip := pickServiceIP(e)
	if ip == nil || ip.String() != "192.168.0.2" {
		t.Fatalf("got %v", ip)
	}
}
