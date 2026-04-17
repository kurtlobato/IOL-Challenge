package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

var videoExtensions = map[string]struct{}{
	".mp4": {}, ".webm": {}, ".mkv": {}, ".mov": {}, ".m4v": {}, ".avi": {},
}

// Scan walks library roots and upserts videos in the store.
func Scan(ctx context.Context, roots []string, st *store.Store) error {
	now := time.Now().UTC()
	for ri, root := range roots {
		root = filepath.Clean(root)
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				name := d.Name()
				if strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if _, ok := videoExtensions[ext]; !ok {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			id := stableID(root, rel)
			title := strings.TrimSuffix(filepath.Base(path), ext)
			ct := contentTypeForExt(ext)
			v := &store.Video{
				ID:          id,
				RootIndex:   ri,
				RelPath:     rel,
				Title:       title,
				SizeBytes:   info.Size(),
				Mtime:       info.ModTime().UTC(),
				ContentType: ct,
				IndexedAt:   now,
			}
			if err := st.UpsertVideo(ctx, v); err != nil {
				return err
			}
			// Best-effort: probe codecs/pix_fmt so clients can flag unsupported sources.
			_ = probeAndUpsertMedia(ctx, st, id, path)
			return nil
		})
		if err != nil {
			return fmt.Errorf("walk %q: %w", root, err)
		}
	}
	return nil
}

type ffprobeOut struct {
	Format struct {
		FormatName string `json:"format_name"`
	} `json:"format"`
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		PixFmt    string `json:"pix_fmt"`
	} `json:"streams"`
}

func probeAndUpsertMedia(ctx context.Context, st *store.Store, videoID, absPath string) error {
	// Skip if already known.
	if mi, err := st.GetMediaInfo(ctx, videoID); err == nil && mi != nil {
		return nil
	}
	// Keep ffprobe from hanging a scan indefinitely.
	pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(pctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		absPath,
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		// ffprobe not installed or file unreadable; ignore.
		return nil
	}
	var parsed ffprobeOut
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		return nil
	}
	vc, ac, pix := "", "", ""
	for _, s := range parsed.Streams {
		switch s.CodecType {
		case "video":
			if vc == "" {
				vc = s.CodecName
				pix = s.PixFmt
			}
		case "audio":
			if ac == "" {
				ac = s.CodecName
			}
		}
	}
	container := parsed.Format.FormatName
	if i := strings.Index(container, ","); i >= 0 {
		container = container[:i]
	}
	return st.UpsertMediaInfo(ctx, &store.MediaInfo{
		VideoID:    videoID,
		Container:  container,
		VideoCodec: vc,
		AudioCodec: ac,
		PixFmt:     pix,
		UpdatedAt:  time.Now().UTC(),
	})
}

func stableID(root, rel string) string {
	// Deterministic UUID from root+rel so rescans keep same id.
	s := filepath.Clean(root) + "\x00" + rel
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(s)).String()
}

func contentTypeForExt(ext string) string {
	switch ext {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	default:
		return "application/octet-stream"
	}
}
