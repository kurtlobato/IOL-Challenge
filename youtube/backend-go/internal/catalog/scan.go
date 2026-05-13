package catalog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
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
	if err := st.DeleteMissingVideos(ctx, now); err != nil {
		return fmt.Errorf("delete missing: %w", err)
	}
	if err := exportMetadata(ctx, roots, st); err != nil {
		return fmt.Errorf("export metadata: %w", err)
	}
	return nil
}

type ffprobeOut struct {
	Format struct {
		FormatName string            `json:"format_name"`
		Tags       map[string]string `json:"tags"`
	} `json:"format"`
	Streams []struct {
		CodecType string            `json:"codec_type"`
		CodecName string            `json:"codec_name"`
		PixFmt    string            `json:"pix_fmt"`
		Tags      map[string]string `json:"tags"`
	} `json:"streams"`
}

func probeAndUpsertMedia(ctx context.Context, st *store.Store, videoID, absPath string) error {
	// Skip if already known and has audio tracks info.
	if mi, err := st.GetMediaInfo(ctx, videoID); err == nil && mi != nil && mi.AudioTracks != "" {
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

	var title string
	for k, v := range parsed.Format.Tags {
		if strings.ToLower(k) == "title" {
			title = v
			break
		}
	}
	if title != "" {
		_ = st.UpdateVideoTitle(ctx, videoID, title)
	}
	type audioTrack struct {
		Index int    `json:"index"`
		Label string `json:"label"`
		Codec string `json:"codec"`
	}
	var audioTracks []audioTrack
	vc, ac, pix := "", "", ""
	for _, s := range parsed.Streams {
		switch s.CodecType {
		case "video":
			if vc == "" {
				vc = s.CodecName
				pix = s.PixFmt
			}
		case "audio":
			lang := s.Tags["language"]
			title := s.Tags["title"]
			
			label := fmt.Sprintf("Audio %d", len(audioTracks)+1)
			if title != "" {
				label = title
			} else if lang != "" {
				label = strings.ToUpper(lang)
			}

			if s.CodecName != "" {
				label += " (" + s.CodecName + ")"
			}
			
			audioTracks = append(audioTracks, audioTrack{
				Index: len(audioTracks),
				Label: label,
				Codec: s.CodecName,
			})
			if ac == "" {
				ac = s.CodecName
			}
		}
	}
	audioTracksJSON, _ := json.Marshal(audioTracks)
	container := parsed.Format.FormatName
	if i := strings.Index(container, ","); i >= 0 {
		container = container[:i]
	}
	return st.UpsertMediaInfo(ctx, &store.MediaInfo{
		VideoID:     videoID,
		Container:   container,
		VideoCodec:  vc,
		AudioCodec:  ac,
		PixFmt:      pix,
		AudioTracks: string(audioTracksJSON),
		UpdatedAt:   time.Now().UTC(),
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

type RootMetadata struct {
	Videos []store.Video  `json:"videos"`
	Series []store.Series `json:"series"`
}

func exportMetadata(ctx context.Context, roots []string, st *store.Store) error {
	videos, err := st.ListVideos(ctx)
	if err != nil {
		return err
	}
	series, err := st.ListSeries(ctx)
	if err != nil {
		return err
	}
	for ri, root := range roots {
		meta := RootMetadata{}
		seriesMap := make(map[string]store.Series)
		for _, v := range videos {
			if v.RootIndex == ri {
				meta.Videos = append(meta.Videos, v)
				if v.SeriesID != nil {
					for _, s := range series {
						if s.ID == *v.SeriesID {
							seriesMap[s.ID] = s
							break
						}
					}
				}
			}
		}
		for _, s := range seriesMap {
			meta.Series = append(meta.Series, s)
		}
		b, err := json.MarshalIndent(meta, "", "  ")
		if err != nil {
			return err
		}
		metaPath := filepath.Join(root, "metadata.json")
		if err := os.WriteFile(metaPath, b, 0644); err != nil {
			return err
		}
	}
	return nil
}
