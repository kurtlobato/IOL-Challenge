package discovery

import (
	"context"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

// BrowseEnabled is false when LANFLIX_MDNS is off, or LANFLIX_MDNS_BROWSE is 0/false/no/off.
func BrowseEnabled() bool {
	if !Enabled() {
		return false
	}
	v := strings.TrimSpace(strings.ToLower(os.Getenv("LANFLIX_MDNS_BROWSE")))
	if v == "" {
		return true
	}
	switch v {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

// BrowseConfig drives periodic mDNS browse for _lanflix._tcp and reports peer base URLs.
type BrowseConfig struct {
	SelfNodeID  string
	ServiceType string // default _lanflix._tcp
	Domain      string // default local.
	StaleAfter  time.Duration
	OnUpdate    func(peers []string)
}

const defaultStaleAfter = 2 * time.Minute

// StartBrowse resolves LAN peers advertising Lanflix. It calls OnUpdate with the current
// deduplicated list (http://host:port), excluding SelfNodeID. Stale entries disappear
// after StaleAfter without a new announcement.
func StartBrowse(ctx context.Context, cfg BrowseConfig) error {
	if strings.TrimSpace(cfg.SelfNodeID) == "" {
		return fmt.Errorf("browse: SelfNodeID required")
	}
	if cfg.OnUpdate == nil {
		return fmt.Errorf("browse: OnUpdate required")
	}
	stale := cfg.StaleAfter
	if stale <= 0 {
		stale = defaultStaleAfter
	}
	svc := strings.TrimSpace(cfg.ServiceType)
	if svc == "" {
		svc = "_lanflix._tcp"
	}
	domain := strings.TrimSpace(cfg.Domain)
	if domain == "" {
		domain = "local."
	}

	resolver, err := zeroconf.NewResolver()
	if err != nil {
		return fmt.Errorf("mdns resolver: %w", err)
	}
	entries := make(chan *zeroconf.ServiceEntry, 64)
	if err := resolver.Browse(ctx, svc, domain, entries); err != nil {
		return fmt.Errorf("mdns browse: %w", err)
	}

	var mu sync.Mutex
	// nodeId -> last base URL and last seen time
	seen := make(map[string]struct {
		base   string
		seenAt time.Time
	})

	snapshot := func() []string {
		mu.Lock()
		defer mu.Unlock()
		now := time.Now()
		for id, v := range seen {
			if now.Sub(v.seenAt) > stale {
				delete(seen, id)
			}
		}
		out := make([]string, 0, len(seen))
		for _, v := range seen {
			out = append(out, v.base)
		}
		sort.Strings(out)
		return out
	}

	notify := func() {
		cfg.OnUpdate(snapshot())
	}

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				notify()
			case e, ok := <-entries:
				if !ok {
					return
				}
				if e == nil {
					continue
				}
				base, peerID := peerFromEntry(e)
				if base == "" || peerID == "" {
					continue
				}
				if peerID == cfg.SelfNodeID {
					continue
				}
				mu.Lock()
				seen[peerID] = struct {
					base   string
					seenAt time.Time
				}{base: base, seenAt: time.Now()}
				mu.Unlock()
				notify()
			}
		}
	}()

	return nil
}

func peerFromEntry(e *zeroconf.ServiceEntry) (baseURL, nodeID string) {
	txt := parseTxtRecords(e.Text)
	nodeID = strings.TrimSpace(txt["nodeId"])
	if nodeID == "" {
		return "", ""
	}
	if e.Port <= 0 || e.Port > 65535 {
		return "", ""
	}
	hostport := hostPortFromEntry(e)
	if hostport == "" {
		return "", ""
	}
	return "http://" + hostport, nodeID
}

func parseTxtRecords(txt []string) map[string]string {
	m := make(map[string]string, len(txt))
	for _, line := range txt {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		i := strings.IndexByte(line, '=')
		if i <= 0 {
			continue
		}
		k := strings.TrimSpace(line[:i])
		v := strings.TrimSpace(line[i+1:])
		if k != "" {
			m[k] = v
		}
	}
	return m
}

func hostPortFromEntry(e *zeroconf.ServiceEntry) string {
	ip := pickServiceIP(e)
	if ip == nil {
		return ""
	}
	return formatHostPort(ip, e.Port)
}

func pickServiceIP(e *zeroconf.ServiceEntry) net.IP {
	for _, ip := range e.AddrIPv4 {
		if ip == nil || ip.IsUnspecified() || ip.IsLoopback() {
			continue
		}
		return ip
	}
	for _, ip := range e.AddrIPv6 {
		if ip == nil || ip.IsUnspecified() || ip.IsLoopback() {
			continue
		}
		// Avoid link-local IPv6 without zone identifier for HTTP client.
		if ip.IsLinkLocalUnicast() {
			continue
		}
		return ip
	}
	for _, ip := range e.AddrIPv6 {
		if ip != nil && !ip.IsUnspecified() && !ip.IsLoopback() {
			return ip
		}
	}
	return nil
}

func formatHostPort(ip net.IP, port int) string {
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.String() + ":" + strconv.Itoa(port)
	}
	return "[" + ip.String() + "]:" + strconv.Itoa(port)
}
