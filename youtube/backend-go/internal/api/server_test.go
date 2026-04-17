package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iol-challenge/youtube/backend-go/internal/config"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

func TestHealth(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestListVideosLocal(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/videos")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var list []videoDTO
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 video, got %d", len(list))
	}
	if list[0].Status != "READY" || list[0].StreamURL == "" {
		t.Fatalf("dto: %+v", list[0])
	}
	if list[0].NodeName == "" {
		t.Fatalf("expected nodeName, dto: %+v", list[0])
	}
	if list[0].ThumbnailURL == nil || *list[0].ThumbnailURL == "" {
		t.Fatalf("expected thumbnailUrl, dto: %+v", list[0])
	}
}

func writeMinimalMP4ForFFmpegTests(t *testing.T, path string) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not in PATH")
	}
	cmd := exec.Command(
		"ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "color=c=black:s=160x120:d=0.5",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", path,
	)
	if err := cmd.Run(); err != nil {
		t.Fatalf("ffmpeg test clip: %v", err)
	}
}

func newTestServerWithFFmpegClip(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "lib")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(root, "clip.mp4")
	writeMinimalMP4ForFFmpegTests(t, f)
	stInfo, err := os.Stat(f)
	if err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dir, "db.sqlite")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	v := &store.Video{
		ID:          "11111111-1111-1111-1111-111111111111",
		RootIndex:   0,
		RelPath:     "clip.mp4",
		Title:       "clip",
		SizeBytes:   stInfo.Size(),
		Mtime:       now,
		ContentType: "video/mp4",
		IndexedAt:   now,
	}
	if err := st.UpsertVideo(ctx, v); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		Listen:       ":0",
		NodeName:     "test",
		Version:      "test",
		LibraryRoots: []string{root},
		Peers:        nil,
	}
	return NewServer(cfg, "22222222-2222-2222-2222-222222222222", st, []string{root}, "http://127.0.0.1", dir)
}

func TestPostThumbnailSetAtSeconds(t *testing.T) {
	t.Parallel()
	srv := newTestServerWithFFmpegClip(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()
	// Composite id as returned by the API for this node + video.
	id := "22222222-2222-2222-2222-222222222222%3A11111111-1111-1111-1111-111111111111"
	req, err := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/videos/"+id+"/thumbnail",
		strings.NewReader(`{"seconds":0.05}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("status %d: %s", res.StatusCode, string(b))
	}
	get, err := http.Get(ts.URL + "/api/videos/" + id + "/thumbnail.jpg")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	if get.StatusCode != http.StatusOK {
		t.Fatalf("thumbnail get status %d", get.StatusCode)
	}
}

func TestPostThumbnailSetInvalidJSON(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()
	id := "22222222-2222-2222-2222-222222222222%3A11111111-1111-1111-1111-111111111111"
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/videos/"+id+"/thumbnail", strings.NewReader(`{`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", res.StatusCode)
	}
}

func TestPeerBaseURLsDedupesStaticAndMDNS(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	srv.cfg.Peers = []string{"http://10.0.0.1:1"}
	srv.SetMDNSPeers([]string{"http://10.0.0.1:1", "http://10.0.0.2:2"})
	got := srv.peerBaseURLs()
	if len(got) != 2 {
		t.Fatalf("expected 2 unique bases, got %d: %v", len(got), got)
	}
}

func TestListVideosFederatedNeverNull(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/videos?federated=true")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var list []videoDTO
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if list == nil {
		t.Fatal("expected [] not null")
	}
}

func TestGetTranscodeStatus(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	res, err := http.Get(ts.URL + "/api/transcode/status")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	var body struct {
		NodeID  string   `json:"nodeId"`
		Running *struct {
			VideoID string `json:"videoId"`
		} `json:"running"`
		Queued []string `json:"queued"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.NodeID == "" {
		t.Fatal("expected nodeId")
	}
	if body.Queued == nil {
		t.Fatal("expected queued array not null")
	}
}

func TestCompositeIdEncodedStillWorks(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	ts := httptest.NewServer(srv.Router())
	defer ts.Close()

	// ':' becomes %3A when used as a path segment.
	id := "22222222-2222-2222-2222-222222222222:11111111-1111-1111-1111-111111111111"
	enc := "22222222-2222-2222-2222-222222222222%3A11111111-1111-1111-1111-111111111111"

	res, err := http.Get(ts.URL + "/api/videos/" + enc)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}

	// And transcode POST should accept encoded id (even if ffmpeg isn't present, it should not 404).
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/videos/"+enc+"/transcode", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("unexpected 404 for %s (%s)", id, enc)
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "lib")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(root, "clip.mp4")
	if err := os.WriteFile(f, []byte("fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(dir, "db.sqlite")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	v := &store.Video{
		ID:          "11111111-1111-1111-1111-111111111111",
		RootIndex:   0,
		RelPath:     "clip.mp4",
		Title:       "clip",
		SizeBytes:   4,
		Mtime:       now,
		ContentType: "video/mp4",
		IndexedAt:   now,
	}
	if err := st.UpsertVideo(ctx, v); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		Listen:       ":0",
		NodeName:     "test",
		Version:      "test",
		LibraryRoots: []string{root},
		Peers:        nil,
	}
	return NewServer(cfg, "22222222-2222-2222-2222-222222222222", st, []string{root}, "http://127.0.0.1", dir)
}
