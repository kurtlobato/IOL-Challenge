package discovery

import (
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"github.com/grandcat/zeroconf"
)

type AdvertiseConfig struct {
	InstanceName string
	ServiceType  string // e.g. _lanflix._tcp
	Port         int
	Text         map[string]string
}

// Enabled returns false only when LANFLIX_MDNS is explicitly set to 0/false.
func Enabled() bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv("LANFLIX_MDNS")))
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

// Advertise registers a DNS-SD service over mDNS and blocks until ctx is done.
func Advertise(ctx context.Context, cfg AdvertiseConfig) error {
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return fmt.Errorf("invalid mdns port: %d", cfg.Port)
	}
	typ := cfg.ServiceType
	if typ == "" {
		typ = "_lanflix._tcp"
	}
	txt := make([]string, 0, len(cfg.Text))
	for k, v := range cfg.Text {
		if k == "" {
			continue
		}
		txt = append(txt, k+"="+v)
	}
	// zeroconf expects service type like "_lanflix._tcp" and a domain.
	srv, err := zeroconf.Register(cfg.InstanceName, typ, "local.", cfg.Port, txt, nil)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		srv.Shutdown()
	}()
	return nil
}

func ParseListenPort(listen string) (int, error) {
	// listen examples: ":8080", "0.0.0.0:8080", "[::]:8080"
	_, portStr, err := net.SplitHostPort(listen)
	if err != nil {
		// If user passed only port "8080"
		if p, err2 := strconv.Atoi(strings.TrimPrefix(listen, ":")); err2 == nil {
			return p, nil
		}
		return 0, err
	}
	return strconv.Atoi(portStr)
}

func BuildTxt(nodeID, nodeName, version string) map[string]string {
	return map[string]string{
		"nodeId":  nodeID,
		"name":    nodeName,
		"version": version,
	}
}

