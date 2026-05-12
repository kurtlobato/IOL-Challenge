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
	"regexp"
	"strconv"
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
	knownSeries := make(map[string]bool)

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
			
			seriesID, season, episode := processSeries(ctx, st, root, rel, knownSeries)

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
				SeriesID:    seriesID,
				Season:      season,
				Episode:     episode,
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

func processSeries(ctx context.Context, st *store.Store, root string, rel string, known map[string]bool) (*string, *int, *int) {
	parts := strings.Split(rel, "/")
	if len(parts) <= 1 {
		return nil, nil, nil
	}

	seriesFolder := parts[0]
	seriesID := stableID(root, seriesFolder)

	if !known[seriesID] {
		known[seriesID] = true
		existing, _ := st.GetSeries(ctx, seriesID)
		if existing == nil {
			s := &store.Series{
				ID:        seriesID,
				Title:     seriesFolder,
				CreatedAt: time.Now().UTC(),
			}

			metaPath := filepath.Join(root, seriesFolder, "metadata.json")
			if b, err := os.ReadFile(metaPath); err == nil {
				var meta struct {
					Title       string `json:"title"`
					Description string `json:"description"`
					Genre       string `json:"genre"`
					Year        *int   `json:"year"`
				}
				if json.Unmarshal(b, &meta) == nil {
					if meta.Title != "" {
						s.Title = meta.Title
					}
					s.Description = meta.Description
					s.Genre = meta.Genre
					s.Year = meta.Year
				}
			}

			entries, _ := os.ReadDir(filepath.Join(root, seriesFolder))
			for _, e := range entries {
				if !e.IsDir() {
					ext := strings.ToLower(filepath.Ext(e.Name()))
					if ext == ".jpg" || ext == ".png" || ext == ".jpeg" || ext == ".webp" {
						s.ThumbRel = seriesFolder + "/" + e.Name()
						break
					}
				}
			}
			_ = st.CreateSeries(ctx, s)
		}
	}

	season, episode := parseSeasonEpisode(rel)

	return &seriesID, season, episode
}

func parseSeasonEpisode(rel string) (*int, *int) {
	base := filepath.Base(rel)
	reSE := regexp.MustCompile(`(?i)[st](\d+)[ec](\d+)`)
	m := reSE.FindStringSubmatch(base)
	if len(m) == 3 {
		s, _ := strconv.Atoi(m[1])
		e, _ := strconv.Atoi(m[2])
		return &s, &e
	}

	parts := strings.Split(rel, "/")
	var season *int
	reSeason := regexp.MustCompile(`(?i)(?:season|temporada)\s*(\d+)`)
	for _, p := range parts[:len(parts)-1] {
		m := reSeason.FindStringSubmatch(p)
		if len(m) == 2 {
			s, _ := strconv.Atoi(m[1])
			season = &s
			break
		}
	}

	if season != nil {
		reEp := regexp.MustCompile(`(?i)(?:episode|capitulo|capítulo|chapter|ep?|c)\s*(?:-|_)?\s*(\d+)`)
		m := reEp.FindStringSubmatch(base)
		if len(m) == 2 {
			e, _ := strconv.Atoi(m[1])
			return season, &e
		}

		reNum := regexp.MustCompile(`\b(\d+)\b`)
		m = reNum.FindStringSubmatch(base)
		if len(m) == 2 {
			e, _ := strconv.Atoi(m[1])
			return season, &e
		}
	}

	return nil, nil
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
			label := fmt.Sprintf("Audio %d", len(audioTracks)+1)
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
