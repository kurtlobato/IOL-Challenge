package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/iol-challenge/youtube/backend-go/internal/config"
	"github.com/iol-challenge/youtube/backend-go/internal/ffmpegcaps"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

// Server exposes REST API for one Lanflix node.
type Server struct {
	cfg     *config.Config
	nodeID  string
	store   *store.Store
	rootsMu sync.RWMutex
	roots   []string
	pub     string // resolved public base URL (may be overridden per request)
	client  *http.Client

	dataDir string

	ffmpegBin         string
	transcodeUseNVENC bool

	transcodeQ chan string
	tcMu       sync.Mutex
	tcState    map[string]string // videoID -> status (QUEUED|RUNNING|READY|FAILED); not persisted keys like _worker_started
	tcQueue    []string          // FIFO of videoIDs waiting (matches channel order)
	tcRunning  string            // videoID currently encoding
	tcProgress *float64          // 0–100 when duration known; nil if unknown
	tcOutMs    int64             // last out_time_ms from ffmpeg for tcRunning

	thumbMu      sync.Mutex
	thumbRunning map[string]struct{} // videoID being generated

	mdnsPeersMu sync.RWMutex
	mdnsPeers   []string // base URLs from mDNS browse (merged with cfg.Peers in peerBaseURLs)
}

// NewServer builds the API handler.
func NewServer(cfg *config.Config, nodeID string, st *store.Store, roots []string, publicBase string, dataDir string) *Server {
	ffmpegBin := strings.TrimSpace(cfg.FFmpegCommand)
	if ffmpegBin == "" {
		ffmpegBin = "ffmpeg"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	useNV := ffmpegcaps.UseNVENC(ctx, ffmpegBin, cfg.FFmpegHardwareAccel)
	cancel()

	return &Server{
		cfg:               cfg,
		nodeID:            nodeID,
		store:             st,
		roots:             roots,
		pub:               strings.TrimRight(publicBase, "/"),
		client:            &http.Client{Timeout: 8 * time.Second},
		dataDir:           strings.TrimSpace(dataDir),
		ffmpegBin:         ffmpegBin,
		transcodeUseNVENC: useNV,
		transcodeQ:        make(chan string, 32),
		tcState:           map[string]string{},
		thumbRunning:      map[string]struct{}{},
	}
}

func (s *Server) SetRoots(roots []string) {
	s.rootsMu.Lock()
	defer s.rootsMu.Unlock()
	s.roots = roots
}

func (s *Server) getRoots() []string {
	s.rootsMu.RLock()
	defer s.rootsMu.RUnlock()
	// copy to avoid races if caller stores it
	out := make([]string, len(s.roots))
	copy(out, s.roots)
	return out
}

// SetMDNSPeers replaces the set of peer base URLs discovered via mDNS (used for federation).
func (s *Server) SetMDNSPeers(urls []string) {
	s.mdnsPeersMu.Lock()
	defer s.mdnsPeersMu.Unlock()
	s.mdnsPeers = append([]string(nil), urls...)
}

func (s *Server) peerBaseURLs() []string {
	seen := map[string]struct{}{}
	var out []string
	add := func(p string) {
		p = strings.TrimSpace(strings.TrimRight(p, "/"))
		if p == "" {
			return
		}
		if _, ok := seen[p]; ok {
			return
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	for _, p := range s.cfg.Peers {
		add(p)
	}
	s.mdnsPeersMu.RLock()
	mdns := s.mdnsPeers
	s.mdnsPeersMu.RUnlock()
	for _, p := range mdns {
		add(p)
	}
	return out
}

// httpPanicLogger registra pánico en handlers con el logger estándar (además de responder 500).
func httpPanicLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				reqID := middleware.GetReqID(r.Context())
				log.Printf("lanflix: panic request_id=%s %s %s: %v", reqID, r.Method, r.URL.Path, rec)
				log.Printf("%s", debug.Stack())
				if r.Header.Get("Connection") != "Upgrade" {
					w.WriteHeader(http.StatusInternalServerError)
				}
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpPanicLogger)
	r.Use(corsMiddleware)

	r.Get("/api/health", s.handleHealth)
	r.Get("/api/nodes", s.handleNodes)
	r.Get("/api/series", s.handleListSeries)
	r.Post("/api/series", s.handlePostSeries)
	r.Get("/api/series/{id}/thumbnail.jpg", s.handleGetSeriesThumbnail)
	r.Get("/api/videos", s.handleListVideos)
	r.Get("/api/videos/{id}", s.handleGetVideo)
	r.Patch("/api/videos/{id}", s.handlePatchVideo)
	r.Delete("/api/videos/{id}", s.handleDeleteVideo)
	r.Get("/api/videos/{id}/thumbnail.jpg", s.handleGetThumbnail)
	r.Post("/api/videos/{id}/thumbnail", s.handlePostThumbnailSet)
	r.Get("/api/videos/{id}/stream", s.handleStream)
	r.Post("/api/videos/{id}/views", s.handlePostView)
	r.Post("/api/videos/{id}/transcode", s.handlePostTranscode)
	r.Get("/api/videos/{id}/transcode.mp4", s.handleGetTranscode)
	r.Get("/api/transcode/status", s.handleGetTranscodeStatus)

	s.ensureTranscodeWorkerStarted()
	return r
}

func httpError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o := r.Header.Get("Origin")
		if o != "" {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Lanflix-Depth")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) publicBaseFromRequest(r *http.Request) string {
	if s.cfg.PublicBaseURL != "" {
		return strings.TrimRight(s.cfg.PublicBaseURL, "/")
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	if xfp := r.Header.Get("X-Forwarded-Proto"); xfp == "https" || xfp == "http" {
		proto = xfp
	}
	host := r.Host
	if host == "" {
		return s.pub
	}
	return proto + "://" + host
}

// --- nodes ---

type nodeDTO struct {
	NodeID  string `json:"nodeId"`
	BaseURL string `json:"baseUrl"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (s *Server) handleNodes(w http.ResponseWriter, r *http.Request) {
	depth := 4
	if d := r.URL.Query().Get("depth"); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n >= 1 && n <= 32 {
			depth = n
		}
	}
	hopHeader := r.Header.Get("X-Lanflix-Depth")
	if hopHeader != "" {
		if n, err := strconv.Atoi(hopHeader); err == nil && n >= 1 {
			depth = n
		}
	}

	nodes, err := s.collectNodes(r, depth)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(nodes); err != nil {
		return
	}
}

func (s *Server) collectNodes(r *http.Request, depth int) ([]nodeDTO, error) {
	self := s.selfNode(r)
	byID := map[string]nodeDTO{self.NodeID: self}
	if depth <= 1 {
		return []nodeDTO{self}, nil
	}
	nextDepth := depth - 1
	if nextDepth < 1 {
		nextDepth = 1
	}
	for _, peer := range s.peerBaseURLs() {
		peer = strings.TrimRight(peer, "/")
		list, err := s.fetchNodes(peer, nextDepth)
		if err != nil {
			continue
		}
		for _, n := range list {
			byID[n.NodeID] = n
		}
	}
	// Orden estable: el nodo local primero (coincide con el cliente que hace la petición), resto por nodeId.
	out := make([]nodeDTO, 0, len(byID))
	out = append(out, self)
	var rest []nodeDTO
	for id, n := range byID {
		if id == self.NodeID {
			continue
		}
		rest = append(rest, n)
	}
	sort.Slice(rest, func(i, j int) bool {
		return rest[i].NodeID < rest[j].NodeID
	})
	out = append(out, rest...)
	return out, nil
}

func (s *Server) selfNode(r *http.Request) nodeDTO {
	return nodeDTO{
		NodeID:  s.nodeID,
		BaseURL: s.publicBaseFromRequest(r),
		Name:    s.cfg.NodeName,
		Version: s.cfg.Version,
	}
}

func (s *Server) fetchNodes(base string, depth int) ([]nodeDTO, error) {
	u := strings.TrimRight(base, "/") + "/api/nodes?depth=" + strconv.Itoa(depth)
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Lanflix-Depth", strconv.Itoa(depth))
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("nodes %s: %s: %s", base, resp.Status, string(b))
	}
	var nodes []nodeDTO
	if err := json.NewDecoder(resp.Body).Decode(&nodes); err != nil {
		return nil, err
	}
	return nodes, nil
}

// --- videos ---

type viewBody struct {
	ViewerKey      string  `json:"viewerKey"`
	WatchedSeconds float64 `json:"watchedSeconds"`
}

type videoDTO struct {
	ID              string         `json:"id"`
	NodeID          string         `json:"nodeId"`
	NodeName        string         `json:"nodeName"`
	Title           string         `json:"title"`
	Description     string         `json:"description"`
	Genre           string         `json:"genre"`
	Year            *int           `json:"year,omitempty"`
	Series          *seriesRefDTO  `json:"series,omitempty"`
	Status          string         `json:"status"`
	StreamURL       string         `json:"streamUrl"`
	ManifestURL     *string        `json:"manifestUrl"`
	ThumbnailURL    *string        `json:"thumbnailUrl"`
	ErrorMessage    *string        `json:"errorMessage"`
	UploaderID      *string        `json:"uploaderId"`
	CreatedAt       string         `json:"createdAt"`
	ProgressPercent *int           `json:"progressPercent"`
	DurationSeconds *float64       `json:"durationSeconds"`
	ViewCount       int64          `json:"viewCount"`
	Source          *sourceDTO     `json:"source,omitempty"`
	Compat          *compatDTO     `json:"compat,omitempty"`
	Transcode       *transcodeDTO  `json:"transcode,omitempty"`
}

type sourceDTO struct {
	Container  string `json:"container"`
	VideoCodec string `json:"videoCodec"`
	AudioCodec string `json:"audioCodec"`
	PixFmt     string `json:"pixFmt"`
}

type compatDTO struct {
	BrowserPlayable bool   `json:"browserPlayable"`
	Reason          string `json:"reason,omitempty"`
}

type transcodeDTO struct {
	Status          string   `json:"status"`
	Error           string   `json:"error,omitempty"`
	Mp4URL          *string  `json:"mp4Url,omitempty"`
	ProgressPercent *float64 `json:"progressPercent,omitempty"`
	QueuePosition   *int     `json:"queuePosition,omitempty"`
	OutTimeMs       *int64   `json:"outTimeMs,omitempty"`
}

func (s *Server) handleListVideos(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("federated") == "true" {
		s.handleListFederated(w, r)
		return
	}
	ctx := r.Context()
	videos, err := s.store.ListVideos(ctx)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	base := s.publicBaseFromRequest(r)
	out := make([]videoDTO, 0, len(videos))
	for _, v := range videos {
		dto, err := s.toVideoDTO(r.Context(), v, base, s.nodeID)
		if err != nil {
			continue
		}
		out = append(out, dto)
	}
	writeJSON(w, out)
}

func (s *Server) handleListFederated(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	nodes, err := s.collectNodes(r, 8)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seen := map[string]struct{}{}
	merged := make([]videoDTO, 0)
	for _, n := range nodes {
		u := strings.TrimRight(n.BaseURL, "/") + "/api/videos"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		resp, err := s.client.Do(req)
		if err != nil {
			continue
		}
		func() {
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return
			}
			var list []videoDTO
			if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
				return
			}
			for _, v := range list {
				if _, ok := seen[v.ID]; ok {
					continue
				}
				seen[v.ID] = struct{}{}
				merged = append(merged, v)
			}
		}()
	}
	sortVideoDTOsByNewestFirst(merged)
	writeJSON(w, merged)
}

// sortVideoDTOsByNewestFirst ordena como ListVideos local (más reciente primero), desempate por id.
func sortVideoDTOsByNewestFirst(list []videoDTO) {
	sort.Slice(list, func(i, j int) bool {
		ti, err1 := time.Parse(time.RFC3339, list[i].CreatedAt)
		tj, err2 := time.Parse(time.RFC3339, list[j].CreatedAt)
		if err1 != nil || err2 != nil {
			return list[i].ID < list[j].ID
		}
		if !ti.Equal(tj) {
			return ti.After(tj)
		}
		return list[i].ID < list[j].ID
	})
}

func (s *Server) toVideoDTO(ctx context.Context, v store.Video, publicBase, nid string) (videoDTO, error) {
	comp := composeID(nid, v.ID)
	vc, _ := s.store.ViewCount(ctx, v.ID)
	base := strings.TrimRight(publicBase, "/")
	stream := fmt.Sprintf("%s/api/videos/%s/stream", base, url.PathEscape(comp))
	thumb := fmt.Sprintf("%s/api/videos/%s/thumbnail.jpg", base, url.PathEscape(comp))

	src, compat := s.getCompat(ctx, v.ID)
	tc := s.getTranscode(ctx, v.ID, base, comp)

	var sref *seriesRefDTO
	if v.SeriesID != nil && *v.SeriesID != "" && v.SeriesTitle != nil {
		compS := composeID(nid, *v.SeriesID)
		var st *string
		if v.SeriesThumbRel != nil && strings.TrimSpace(*v.SeriesThumbRel) != "" && s.dataDir != "" {
			full := filepath.Join(s.dataDir, filepath.FromSlash(*v.SeriesThumbRel))
			if stf, err := os.Stat(full); err == nil && stf.Size() > 0 {
				u := fmt.Sprintf("%s/api/series/%s/thumbnail.jpg", base, url.PathEscape(compS))
				st = &u
			}
		}
		sref = &seriesRefDTO{
			ID:           compS,
			NodeID:       nid,
			Title:        *v.SeriesTitle,
			Description:  v.SeriesDescription,
			Genre:        v.SeriesGenre,
			Year:         v.SeriesYear,
			ThumbnailURL: st,
		}
	}

	return videoDTO{
		ID:              comp,
		NodeID:          nid,
		NodeName:        strings.TrimSpace(s.cfg.NodeName),
		Title:           v.Title,
		Description:     v.Description,
		Genre:           v.Genre,
		Year:            v.Year,
		Series:          sref,
		Status:          "READY",
		StreamURL:       stream,
		ManifestURL:     nil,
		ThumbnailURL:    &thumb,
		ErrorMessage:    nil,
		UploaderID:      nil,
		CreatedAt:       v.Mtime.Format(time.RFC3339),
		ProgressPercent: nil,
		DurationSeconds: v.DurationSeconds,
		ViewCount:       vc,
		Source:          src,
		Compat:          compat,
		Transcode:       tc,
	}, nil
}

func (s *Server) thumbnailRelPath(videoID string) string {
	return filepath.ToSlash(filepath.Join("thumbnails", videoID+".jpg"))
}

func (s *Server) handleGetThumbnail(w http.ResponseWriter, r *http.Request) {
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
	if s.dataDir == "" {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	v, err := s.store.GetVideo(ctx, vid)
	if err != nil || v == nil {
		http.NotFound(w, r)
		return
	}

	outFull := filepath.Join(s.dataDir, filepath.FromSlash(s.thumbnailRelPath(vid)))
	if st, err := os.Stat(outFull); err == nil && st.Size() > 0 {
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, outFull)
		return
	}

	s.thumbMu.Lock()
	if _, ok := s.thumbRunning[vid]; ok {
		s.thumbMu.Unlock()
		http.NotFound(w, r)
		return
	}
	s.thumbRunning[vid] = struct{}{}
	s.thumbMu.Unlock()
	defer func() {
		s.thumbMu.Lock()
		delete(s.thumbRunning, vid)
		s.thumbMu.Unlock()
	}()

	roots := s.getRoots()
	if v.RootIndex < 0 || v.RootIndex >= len(roots) {
		http.NotFound(w, r)
		return
	}
	inPath, err := resolveVideoPath(roots[v.RootIndex], v.RelPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if err := os.MkdirAll(filepath.Dir(outFull), 0o755); err != nil {
		http.NotFound(w, r)
		return
	}
	tmp := strings.TrimSuffix(outFull, ".jpg") + ".tmp.jpg"
	_ = os.Remove(tmp)

	tctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(tctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-ss", "00:00:03",
		"-i", inPath,
		"-frames:v", "1",
		"-vf", "scale=360:-1",
		"-q:v", "4",
		tmp,
	)
	_ = cmd.Run()
	if st, err := os.Stat(tmp); err == nil && st.Size() > 0 {
		_ = os.Rename(tmp, outFull)
	}
	if st, err := os.Stat(outFull); err == nil && st.Size() > 0 {
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, outFull)
		return
	}
	http.NotFound(w, r)
}

// handlePostThumbnailSet writes thumbnail.jpg from a frame at JSON body {"seconds": n} using ffmpeg.
func (s *Server) handlePostThumbnailSet(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusNotFound, "video lives on another node")
		return
	}
	if s.dataDir == "" {
		httpError(w, http.StatusInternalServerError, "data dir not configured")
		return
	}
	ctx := r.Context()
	v, err := s.store.GetVideo(ctx, vid)
	if err != nil || v == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	var body struct {
		Seconds float64 `json:"seconds"`
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	sec := body.Seconds
	if math.IsNaN(sec) || math.IsInf(sec, 0) || sec < 0 {
		httpError(w, http.StatusBadRequest, "invalid seconds")
		return
	}
	if sec > 24*3600 {
		httpError(w, http.StatusBadRequest, "seconds too large")
		return
	}
	if v.DurationSeconds != nil && *v.DurationSeconds > 0 {
		if sec > *v.DurationSeconds {
			sec = *v.DurationSeconds - 1e-3
		}
	}

	roots := s.getRoots()
	if v.RootIndex < 0 || v.RootIndex >= len(roots) {
		httpError(w, http.StatusNotFound, "library root missing")
		return
	}
	inPath, err := resolveVideoPath(roots[v.RootIndex], v.RelPath)
	if err != nil {
		httpError(w, http.StatusNotFound, "source file missing")
		return
	}
	outFull := filepath.Join(s.dataDir, filepath.FromSlash(s.thumbnailRelPath(vid)))
	if err := os.MkdirAll(filepath.Dir(outFull), 0o755); err != nil {
		httpError(w, http.StatusInternalServerError, "mkdir")
		return
	}
	tmp := strings.TrimSuffix(outFull, ".jpg") + ".tmp.jpg"
	_ = os.Remove(tmp)

	tctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(tctx, "ffmpeg",
		"-hide_banner",
		"-loglevel", "error",
		"-y",
		"-i", inPath,
		"-ss", fmt.Sprintf("%.3f", sec),
		"-frames:v", "1",
		"-vf", "scale=360:-1",
		"-q:v", "4",
		tmp,
	)
	if err := cmd.Run(); err != nil {
		httpError(w, http.StatusInternalServerError, "ffmpeg failed")
		return
	}
	if st, err := os.Stat(tmp); err != nil || st.Size() == 0 {
		httpError(w, http.StatusInternalServerError, "thumbnail not written")
		return
	}
	if err := os.Rename(tmp, outFull); err != nil {
		httpError(w, http.StatusInternalServerError, "rename failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getCompat(ctx context.Context, videoID string) (*sourceDTO, *compatDTO) {
	mi, err := s.store.GetMediaInfo(ctx, videoID)
	if err != nil || mi == nil {
		return nil, nil
	}
	src := &sourceDTO{
		Container:  mi.Container,
		VideoCodec: mi.VideoCodec,
		AudioCodec: mi.AudioCodec,
		PixFmt:     mi.PixFmt,
	}
	// Conservative heuristic for Electron/browser:
	// video: h264 + yuv420p (8-bit) and audio: aac.
	playable := strings.EqualFold(mi.VideoCodec, "h264") &&
		strings.EqualFold(mi.PixFmt, "yuv420p") &&
		(strings.EqualFold(mi.AudioCodec, "aac") || mi.AudioCodec == "")
	var reason string
	if !playable {
		reason = fmt.Sprintf("%s/%s/%s", mi.VideoCodec, mi.AudioCodec, mi.PixFmt)
	}
	return src, &compatDTO{BrowserPlayable: playable, Reason: reason}
}

func (s *Server) getTranscode(ctx context.Context, videoID, base, comp string) *transcodeDTO {
	tc, err := s.store.GetTranscodeInfo(ctx, videoID)
	if err != nil || tc == nil {
		return nil
	}
	out := &transcodeDTO{Status: tc.Status}
	if tc.Error != "" {
		out.Error = tc.Error
	}
	if tc.Status == "READY" && tc.OutputPath != "" {
		u := fmt.Sprintf("%s/api/videos/%s/transcode.mp4", base, url.PathEscape(comp))
		out.Mp4URL = &u
	}

	s.tcMu.Lock()
	defer s.tcMu.Unlock()

	switch tc.Status {
	case "READY", "FAILED":
		// DB is authoritative
	default:
		if st := s.tcState[videoID]; st != "" && st != "_worker_started" {
			out.Status = st
		}
	}
	if out.Status == "RUNNING" && s.tcRunning == videoID {
		if s.tcProgress != nil {
			p := *s.tcProgress
			out.ProgressPercent = &p
		}
		if s.tcOutMs > 0 {
			ms := s.tcOutMs
			out.OutTimeMs = &ms
		}
	}
	if out.Status == "QUEUED" {
		if pos := transcodeQueuePosition(s.tcQueue, videoID); pos > 0 {
			out.QueuePosition = &pos
		}
	}
	return out
}

func transcodeQueuePosition(q []string, vid string) int {
	for i, x := range q {
		if x == vid {
			return i + 1
		}
	}
	return 0
}

func composeID(nodeID, videoID string) string {
	return nodeID + ":" + videoID
}

func parseCompositeID(id string) (nodeID, videoID string, ok bool) {
	i := strings.Index(id, ":")
	if i <= 0 || i >= len(id)-1 {
		return "", "", false
	}
	return id[:i], id[i+1:], true
}

func readVideoIDParam(r *http.Request) string {
	raw := chi.URLParam(r, "id")
	if raw == "" {
		return raw
	}
	// chi does not automatically unescape %3A etc. in params.
	if u, err := url.PathUnescape(raw); err == nil && u != "" {
		return u
	}
	return raw
}

func (s *Server) handleGetVideo(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusNotFound, "video lives on another node; use streamUrl from list")
		return
	}
	ctx := r.Context()
	v, err := s.store.GetVideo(ctx, vid)
	if err != nil || v == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	base := s.publicBaseFromRequest(r)
	dto, err := s.toVideoDTO(r.Context(), *v, base, s.nodeID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, dto)
}

type patchVideoBody struct {
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Genre       string  `json:"genre"`
	Year        *int    `json:"year"`
	SeriesID    *string `json:"seriesId"`
}

func (s *Server) handlePatchVideo(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusNotFound, "video lives on another node; use streamUrl from list")
		return
	}
	var body patchVideoBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		httpError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		httpError(w, http.StatusBadRequest, "title required")
		return
	}
	var localSeries *string
	if body.SeriesID != nil && strings.TrimSpace(*body.SeriesID) != "" {
		snid, suid, ok := parseCompositeID(strings.TrimSpace(*body.SeriesID))
		if !ok {
			suid = strings.TrimSpace(*body.SeriesID)
			snid = s.nodeID
		}
		if snid != s.nodeID {
			httpError(w, http.StatusBadRequest, "series must belong to this node")
			return
		}
		se, err := s.store.GetSeries(r.Context(), suid)
		if err != nil || se == nil {
			httpError(w, http.StatusNotFound, "series not found")
			return
		}
		localSeries = &suid
	}
	if err := s.store.UpdateVideoMetadata(r.Context(), vid, body.Title, body.Description, body.Genre, body.Year, localSeries); err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.NotFound(w, r)
			return
		}
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := s.store.GetVideo(r.Context(), vid)
	if err != nil || v == nil {
		http.NotFound(w, r)
		return
	}
	base := s.publicBaseFromRequest(r)
	dto, err := s.toVideoDTO(r.Context(), *v, base, s.nodeID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, dto)
}

func (s *Server) handleDeleteVideo(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusNotFound, "video lives on another node; use streamUrl from list")
		return
	}
	if err := s.store.HideVideo(r.Context(), vid); err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.NotFound(w, r)
			return
		}
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		http.Error(w, "wrong node for this id", http.StatusNotFound)
		return
	}
	ctx := r.Context()
	v, err := s.store.GetVideo(ctx, vid)
	if err != nil || v == nil {
		http.NotFound(w, r)
		return
	}
	if v.RootIndex < 0 || v.RootIndex >= len(s.roots) {
		http.Error(w, "bad root", http.StatusInternalServerError)
		return
	}
	roots := s.getRoots()
	if v.RootIndex < 0 || v.RootIndex >= len(roots) {
		http.Error(w, "bad root", http.StatusInternalServerError)
		return
	}
	root := filepath.Clean(roots[v.RootIndex])
	osFile, err := openUnderRoot(root, v.RelPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer osFile.Close()
	st, err := osFile.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := v.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(v.RelPath), st.ModTime(), osFile)
}

func (s *Server) handlePostView(w http.ResponseWriter, r *http.Request) {
	id := readVideoIDParam(r)
	nid, vid, composite := parseCompositeID(id)
	if !composite {
		vid = id
		nid = s.nodeID
	}
	if nid != s.nodeID {
		httpError(w, http.StatusBadRequest, "view must be recorded on the node that owns the video")
		return
	}
	var body viewBody
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&body)
	}
	c, err := s.store.RecordView(r.Context(), vid)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]int64{"viewCount": c})
}

func openUnderRoot(root, rel string) (*os.File, error) {
	root = filepath.Clean(root)
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	p := filepath.Join(rootAbs, filepath.FromSlash(rel))
	p, err = filepath.Abs(p)
	if err != nil {
		return nil, err
	}
	relToRoot, err := filepath.Rel(rootAbs, p)
	if err != nil || strings.HasPrefix(relToRoot, "..") {
		return nil, fmt.Errorf("path escape")
	}
	return os.Open(p)
}
