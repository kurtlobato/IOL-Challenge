package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

func (s *Server) transcodeFFmpegArgs(inPath, tmp string) []string {
	base := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-progress", "pipe:1",
		"-nostats",
		"-i", inPath,
	}
	var v []string
	if s.transcodeUseNVENC {
		v = []string{
			"-c:v", "h264_nvenc",
			"-pix_fmt", "yuv420p",
			"-preset", "p4",
			"-tune", "hq",
			"-rc", "vbr",
			"-cq", "22",
		}
	} else {
		v = []string{
			"-c:v", "libx264",
			"-pix_fmt", "yuv420p",
			"-preset", "veryfast",
			"-crf", "22",
		}
	}
	out := append(append(append([]string{}, base...), v...), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp)
	return out
}

func (s *Server) handlePostTranscode(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusBadRequest, "transcode must be requested on the node that owns the video")
		return
	}
	if s.dataDir == "" {
		httpError(w, http.StatusInternalServerError, "data dir not configured")
		return
	}
	v, err := s.store.GetVideo(r.Context(), vid)
	if err != nil || v == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}

	// Ensure media info exists (best effort).
	_ = s.ensureMediaInfo(r.Context(), vid, *v)

	tc, _ := s.store.GetTranscodeInfo(r.Context(), vid)
	if tc != nil && tc.Status == "READY" && tc.OutputPath != "" {
		writeJSON(w, map[string]string{"status": "READY"})
		return
	}

	s.tcMu.Lock()
	cur := s.tcState[vid]
	s.tcMu.Unlock()

	if cur == "QUEUED" || cur == "RUNNING" {
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, map[string]string{"status": cur})
		return
	}

	// Enqueue.
	select {
	case s.transcodeQ <- vid:
		s.tcMu.Lock()
		s.tcState[vid] = "QUEUED"
		s.tcQueue = append(s.tcQueue, vid)
		s.tcMu.Unlock()
		_ = s.store.UpsertTranscodeInfo(r.Context(), &store.TranscodeInfo{
			VideoID:    vid,
			Status:     "QUEUED",
			Error:      "",
			OutputPath: s.transcodeOutputRelPath(vid),
			UpdatedAt:  time.Now().UTC(),
		})
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, map[string]string{"status": "QUEUED"})
	default:
		httpError(w, http.StatusTooManyRequests, "transcode queue is full")
	}
}

func (s *Server) handleGetTranscode(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		http.NotFound(w, r)
		return
	}
	tc, err := s.store.GetTranscodeInfo(r.Context(), vid)
	if err != nil || tc == nil || tc.Status != "READY" || tc.OutputPath == "" {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(s.dataDir, filepath.FromSlash(tc.OutputPath))
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(full), st.ModTime(), f)
}

func (s *Server) ensureTranscodeWorkerStarted() {
	// Start at most once by racing on channel consumer creation.
	// We piggyback on tcState: when map exists, we still need a worker; keep it simple:
	// Start a goroutine on first call.
	s.tcMu.Lock()
	if s.tcState == nil {
		s.tcState = map[string]string{}
	}
	already := s.tcState["_worker_started"] == "1"
	if !already {
		s.tcState["_worker_started"] = "1"
	}
	s.tcMu.Unlock()
	if already {
		return
	}
	go s.transcodeWorkerLoop()
}

func (s *Server) transcodeWorkerLoop() {
	for vid := range s.transcodeQ {
		s.tcMu.Lock()
		s.dequeueTranscodeJob(vid)
		s.tcState[vid] = "RUNNING"
		s.tcRunning = vid
		s.tcProgress = nil
		s.tcOutMs = 0
		s.tcMu.Unlock()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		err := s.runTranscode(ctx, vid)
		cancel()

		s.tcMu.Lock()
		if s.tcRunning == vid {
			s.tcRunning = ""
			s.tcProgress = nil
			s.tcOutMs = 0
		}
		if err != nil {
			s.tcState[vid] = "FAILED"
		} else {
			s.tcState[vid] = "READY"
		}
		s.tcMu.Unlock()
	}
}

// dequeueTranscodeJob removes vid from the head of tcQueue (FIFO aligned with channel).
func (s *Server) dequeueTranscodeJob(vid string) {
	if len(s.tcQueue) == 0 {
		return
	}
	if s.tcQueue[0] == vid {
		s.tcQueue = s.tcQueue[1:]
		return
	}
	for i, x := range s.tcQueue {
		if x == vid {
			s.tcQueue = append(s.tcQueue[:i], s.tcQueue[i+1:]...)
			return
		}
	}
}

type transcodeStatusDTO struct {
	NodeID  string               `json:"nodeId"`
	Running *transcodeRunningDTO `json:"running"`
	Queued  []string             `json:"queued"`
}

type transcodeRunningDTO struct {
	VideoID         string   `json:"videoId"`
	ProgressPercent *float64 `json:"progressPercent,omitempty"`
	OutTimeMs       *int64   `json:"outTimeMs,omitempty"`
}

func (s *Server) handleGetTranscodeStatus(w http.ResponseWriter, r *http.Request) {
	s.tcMu.Lock()
	queued := make([]string, len(s.tcQueue))
	copy(queued, s.tcQueue)
	dto := transcodeStatusDTO{NodeID: s.nodeID, Queued: queued}
	if s.tcRunning != "" {
		rj := &transcodeRunningDTO{VideoID: s.tcRunning}
		if s.tcProgress != nil {
			p := *s.tcProgress
			rj.ProgressPercent = &p
		}
		if s.tcOutMs > 0 {
			ms := s.tcOutMs
			rj.OutTimeMs = &ms
		}
		dto.Running = rj
	}
	s.tcMu.Unlock()
	writeJSON(w, dto)
}

func (s *Server) transcodeOutputRelPath(videoID string) string {
	return filepath.ToSlash(filepath.Join("transcodes", videoID+".mp4"))
}

func (s *Server) runTranscode(ctx context.Context, videoID string) error {
	if s.dataDir == "" {
		return errors.New("data dir not configured")
	}
	v, err := s.store.GetVideo(ctx, videoID)
	if err != nil || v == nil {
		return errors.New("not found")
	}
	roots := s.getRoots()
	if v.RootIndex < 0 || v.RootIndex >= len(roots) {
		return fmt.Errorf("bad root")
	}
	inPath, err := resolveVideoPath(roots[v.RootIndex], v.RelPath)
	if err != nil {
		return err
	}

	outRel := s.transcodeOutputRelPath(videoID)
	outFull := filepath.Join(s.dataDir, filepath.FromSlash(outRel))
	if err := os.MkdirAll(filepath.Dir(outFull), 0o755); err != nil {
		return err
	}
	// FFmpeg infiere el muxer por extensión; ".mp4.tmp" no es válido.
	tmp := strings.TrimSuffix(outFull, ".mp4") + ".tmp.mp4"
	_ = os.Remove(tmp)

	durMs := int64(0)
	if v.DurationSeconds != nil && *v.DurationSeconds > 0 {
		durMs = int64(*v.DurationSeconds * 1000.0)
	}

	cmd := exec.CommandContext(ctx, s.ffmpegBin, s.transcodeFFmpegArgs(inPath, tmp)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	progDone := make(chan struct{})
	go func() {
		defer close(progDone)
		s.readFFmpegProgress(stdout, videoID, durMs)
	}()

	if err := cmd.Start(); err != nil {
		go func() { _, _ = io.Copy(io.Discard, stdout) }()
		<-progDone
		return err
	}
	waitErr := cmd.Wait()
	<-progDone

	if waitErr != nil {
		_ = s.store.UpsertTranscodeInfo(context.Background(), &store.TranscodeInfo{
			VideoID:    videoID,
			Status:     "FAILED",
			Error:      strings.TrimSpace(tail(stderr.String(), 3000)),
			OutputPath: "",
			UpdatedAt:  time.Now().UTC(),
		})
		return fmt.Errorf("ffmpeg: %w", waitErr)
	}
	if err := os.Rename(tmp, outFull); err != nil {
		return err
	}
	_ = s.store.UpsertTranscodeInfo(context.Background(), &store.TranscodeInfo{
		VideoID:    videoID,
		Status:     "READY",
		Error:      "",
		OutputPath: outRel,
		UpdatedAt:  time.Now().UTC(),
	})
	return nil
}

func resolveVideoPath(root, rel string) (string, error) {
	root = filepath.Clean(root)
	p := filepath.Join(root, filepath.FromSlash(rel))
	p, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	relToRoot, err := filepath.Rel(rootAbs, p)
	if err != nil || strings.HasPrefix(relToRoot, "..") {
		return "", fmt.Errorf("path escape")
	}
	return p, nil
}

func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[len(s)-max:]
}

// readFFmpegProgress parses -progress pipe:1 lines (out_time_ms) until stdout closes.
func (s *Server) readFFmpegProgress(r io.Reader, videoID string, durMs int64) {
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "out_time_ms=") {
			continue
		}
		msStr := strings.TrimPrefix(line, "out_time_ms=")
		ms, err := strconv.ParseInt(msStr, 10, 64)
		if err != nil {
			continue
		}
		s.tcMu.Lock()
		if s.tcRunning == videoID {
			s.tcOutMs = ms
			if durMs > 0 {
				p := float64(ms) / float64(durMs) * 100.0
				if p > 100 {
					p = 100
				}
				if p < 0 {
					p = 0
				}
				fp := p
				s.tcProgress = &fp
			}
		}
		s.tcMu.Unlock()
	}
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

func (s *Server) ensureMediaInfo(ctx context.Context, videoID string, v store.Video) error {
	if _, err := s.store.GetMediaInfo(ctx, videoID); err == nil {
		// If exists, skip.
		if mi, _ := s.store.GetMediaInfo(ctx, videoID); mi != nil {
			return nil
		}
	}
	roots := s.getRoots()
	if v.RootIndex < 0 || v.RootIndex >= len(roots) {
		return nil
	}
	inPath, err := resolveVideoPath(roots[v.RootIndex], v.RelPath)
	if err != nil {
		return nil
	}
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		inPath,
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
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
	return s.store.UpsertMediaInfo(ctx, &store.MediaInfo{
		VideoID:    videoID,
		Container:  container,
		VideoCodec: vc,
		AudioCodec: ac,
		PixFmt:     pix,
		UpdatedAt:  time.Now().UTC(),
	})
}
