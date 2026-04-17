package config

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config describes one Lanflix node (library roots, listen address, peers).
type Config struct {
	Listen         string   `yaml:"listen"`
	DataDir        string   `yaml:"data_dir"`
	LibraryRoots   []string `yaml:"library_roots"`
	Peers          []string `yaml:"peers"`
	PublicBaseURL  string   `yaml:"public_base_url"`
	NodeName       string   `yaml:"node_name"`
	Version        string   `yaml:"-"`
}

// Load reads YAML from path or LANFLIX_CONFIG, with env overrides.
func Load(version string) (*Config, error) {
	path, err := ResolveConfigPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	cfg := &Config{
		Listen:       ":8080",
		DataDir:      "./data",
		LibraryRoots: []string{},
		Peers:        []string{},
		Version:      version,
		NodeName:     defaultNodeName(),
	}
	if len(data) > 0 {
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	}
	if v := os.Getenv("LANFLIX_LISTEN"); v != "" {
		cfg.Listen = v
	}
	if v := os.Getenv("LANFLIX_DATA_DIR"); v != "" {
		cfg.DataDir = v
	}
	if v := os.Getenv("LANFLIX_PUBLIC_BASE_URL"); v != "" {
		cfg.PublicBaseURL = strings.TrimRight(v, "/")
	}
	if v := os.Getenv("LANFLIX_NODE_NAME"); v != "" {
		cfg.NodeName = v
	}
	if v := os.Getenv("LANFLIX_LIBRARY_ROOTS"); v != "" {
		var roots []string
		for _, p := range strings.Split(v, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				roots = append(roots, p)
			}
		}
		cfg.LibraryRoots = roots
	}
	if v := os.Getenv("LANFLIX_PEERS"); v != "" {
		var peers []string
		for _, p := range strings.Split(v, ",") {
			p = strings.TrimSpace(strings.TrimRight(p, "/"))
			if p != "" {
				peers = append(peers, p)
			}
		}
		cfg.Peers = peers
	}
	return cfg, nil
}

func defaultNodeName() string {
	u, err := user.Current()
	if err == nil && u != nil {
		name := strings.TrimSpace(u.Username)
		if name != "" {
			return name
		}
	}
	return hostnameOr("lanflix")
}

func hostnameOr(fallback string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return fallback
	}
	return h
}

// ResolveConfigPath picks a config path with the following precedence:
// 1) LANFLIX_CONFIG
// 2) ./lanflix.yaml (if present)
// 3) OS user config dir: <UserConfigDir>/lanflix/config.yaml
func ResolveConfigPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("LANFLIX_CONFIG")); p != "" {
		return p, nil
	}
	if _, err := os.Stat("lanflix.yaml"); err == nil {
		return "lanflix.yaml", nil
	}
	ucd, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(ucd, "lanflix", "config.yaml"), nil
}

func Save(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}
