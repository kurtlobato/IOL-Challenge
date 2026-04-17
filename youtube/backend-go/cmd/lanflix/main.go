package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/iol-challenge/youtube/backend-go/internal/api"
	"github.com/iol-challenge/youtube/backend-go/internal/catalog"
	"github.com/iol-challenge/youtube/backend-go/internal/config"
	"github.com/iol-challenge/youtube/backend-go/internal/discovery"
	"github.com/iol-challenge/youtube/backend-go/internal/nodeid"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
	"github.com/iol-challenge/youtube/backend-go/internal/ui"
)

const version = "0.1.0"

func main() {
	log.SetFlags(0)
	cfg, err := config.Load(version)
	if err != nil {
		log.Fatal(err)
	}
	dataDir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		log.Fatal(err)
	}
	nid, err := nodeid.LoadOrCreate(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	dbPath := filepath.Join(dataDir, "catalog.db")
	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	roots := make([]string, 0, len(cfg.LibraryRoots))
	for _, r := range cfg.LibraryRoots {
		abs, err := filepath.Abs(r)
		if err != nil {
			log.Fatal(err)
		}
		roots = append(roots, abs)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if len(roots) > 0 {
		if err := catalog.Scan(ctx, roots, st); err != nil {
			log.Printf("catalog scan: %v", err)
		}
	} else {
		log.Printf("catalog scan: skipped (no library_roots configured)")
	}

	pub := cfg.PublicBaseURL
	srv := api.NewServer(cfg, nid, st, roots, pub, dataDir)
	h := srv.Router()

	s := &http.Server{
		Addr:              cfg.Listen,
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Shutdown orchestration: SIGINT/SIGTERM cancels ctx and stops HTTP.
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-ch
		cancel()
		ctxShutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		_ = s.Shutdown(ctxShutdown)
	}()

	go func() {
		log.Printf("lanflix %s node=%s listen=%s", version, nid, cfg.Listen)
		if err := s.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	// Integrated GUI (optional; requires build tag -tags fyne).
	cfgPath, _ := config.ResolveConfigPath()

	if discovery.Enabled() {
		if port, err := discovery.ParseListenPort(cfg.Listen); err == nil {
			name := strings.TrimSpace(cfg.NodeName)
			if name == "" {
				name = "LANflix-" + nid[:8]
			}
			mdnsCfg := discovery.AdvertiseConfig{
				InstanceName: name,
				ServiceType:  "_lanflix._tcp",
				Port:         port,
				Text: map[string]string{
					"nodeId":  nid,
					"name":    cfg.NodeName,
					"version": version,
				},
			}
			if err := discovery.Advertise(ctx, mdnsCfg); err != nil {
				log.Printf("mdns advertise: %v", err)
			} else {
				log.Printf("mdns: advertising %q on _lanflix._tcp:%d", name, port)
			}
		} else {
			log.Printf("mdns: disabled (invalid listen): %v", err)
		}
	} else {
		log.Printf("mdns: disabled by LANFLIX_MDNS=0")
	}

	// Fyne requires Run() on the main goroutine; ui.Start is a no-op when not built with -tags fyne.
	_ = ui.Start(ctx, cfgPath, cfg, st, srv, func(newRoots []string) {
		absRoots := make([]string, 0, len(newRoots))
		for _, r := range newRoots {
			abs, err := filepath.Abs(r)
			if err != nil {
				continue
			}
			absRoots = append(absRoots, abs)
		}
		srv.SetRoots(absRoots)
	})

	// If UI isn't enabled (no-op), keep process alive until shutdown.
	<-ctx.Done()
}
