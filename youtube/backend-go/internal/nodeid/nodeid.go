package nodeid

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const fileName = "node-id"

// LoadOrCreate returns a stable node UUID persisted under dataDir.
func LoadOrCreate(dataDir string) (string, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dataDir, fileName)
	b, err := os.ReadFile(p)
	if err == nil && len(b) > 0 {
		s := strings.TrimSpace(string(b))
		if _, err := uuid.Parse(s); err == nil {
			return s, nil
		}
	}
	id := uuid.NewString()
	if err := os.WriteFile(p, []byte(id), 0o600); err != nil {
		return "", err
	}
	return id, nil
}
