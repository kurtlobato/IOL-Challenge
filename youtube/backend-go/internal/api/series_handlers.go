package api

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

type seriesDTO struct {
	ID            string  `json:"id"`
	NodeID        string  `json:"nodeId"`
	Title         string  `json:"title"`
	Description   string  `json:"description"`
	Genre         string  `json:"genre"`
	Year          *int    `json:"year,omitempty"`
	ThumbnailURL  *string `json:"thumbnailUrl,omitempty"`
}

type seriesRefDTO struct {
	ID           string  `json:"id"`
	NodeID       string  `json:"nodeId"`
	Title        string  `json:"title"`
	Description  string  `json:"description,omitempty"`
	Genre        string  `json:"genre,omitempty"`
	Year         *int    `json:"year,omitempty"`
	ThumbnailURL *string `json:"thumbnailUrl,omitempty"`
}

func (s *Server) handleListSeries(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := s.store.ListSeries(ctx)
	if err != nil {
		httpError(w, http.StatusInternalServerError, err.Error())
		return
	}
	base := s.publicBaseFromRequest(r)
	out := make([]seriesDTO, 0, len(list))
	for _, x := range list {
		out = append(out, s.seriesToDTO(x, base))
	}
	writeJSON(w, out)
}

func (s *Server) seriesToDTO(x store.Series, publicBase string) seriesDTO {
	base := strings.TrimRight(publicBase, "/")
	comp := composeID(s.nodeID, x.ID)
	dto := seriesDTO{
		ID:          comp,
		NodeID:      s.nodeID,
		Title:       x.Title,
		Description: x.Description,
		Genre:       x.Genre,
		Year:        x.Year,
	}
	if strings.TrimSpace(x.ThumbRel) != "" {
		full := filepath.Join(s.dataDir, filepath.FromSlash(x.ThumbRel))
		if st, err := os.Stat(full); err == nil && st.Size() > 0 {
			u := fmt.Sprintf("%s/api/series/%s/thumbnail.jpg", base, url.PathEscape(comp))
			dto.ThumbnailURL = &u
		}
	}
	return dto
}

func (s *Server) handlePostSeries(w http.ResponseWriter, r *http.Request) {
	if s.dataDir == "" {
		httpError(w, http.StatusInternalServerError, "data dir not configured")
		return
	}
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httpError(w, http.StatusBadRequest, "multipart expected")
		return
	}
	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		httpError(w, http.StatusBadRequest, "title required")
		return
	}
	id := uuid.NewString()
	desc := strings.TrimSpace(r.FormValue("description"))
	genre := strings.TrimSpace(r.FormValue("genre"))
	var year *int
	if ys := strings.TrimSpace(r.FormValue("year")); ys != "" {
		y, err := strconv.Atoi(ys)
		if err != nil {
			httpError(w, http.StatusBadRequest, "invalid year")
			return
		}
		year = &y
	}
	thumbRel := ""
	if fh, hdr, err := r.FormFile("thumbnail"); err == nil {
		defer fh.Close()
		if hdr.Size > 10<<20 {
			httpError(w, http.StatusBadRequest, "thumbnail too large")
			return
		}
		ct := hdr.Header.Get("Content-Type")
		if ct != "" && !strings.HasPrefix(ct, "image/") {
			httpError(w, http.StatusBadRequest, "thumbnail must be an image")
			return
		}
		dir := filepath.Join(s.dataDir, "series")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		dest := filepath.Join(dir, id+".jpg")
		out, err := os.Create(dest)
		if err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		_, err = io.Copy(out, io.LimitReader(fh, 10<<20))
		_ = out.Close()
		if err != nil {
			httpError(w, http.StatusInternalServerError, err.Error())
			return
		}
		thumbRel = filepath.ToSlash(filepath.Join("series", id+".jpg"))
	}
	ser := &store.Series{
		ID:          id,
		Title:       title,
		Description: desc,
		Genre:       genre,
		Year:        year,
		ThumbRel:    thumbRel,
	}
	if err := s.store.CreateSeries(r.Context(), ser); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	got, _ := s.store.GetSeries(r.Context(), id)
	if got == nil {
		httpError(w, http.StatusInternalServerError, "series not persisted")
		return
	}
	base := s.publicBaseFromRequest(r)
	writeJSON(w, s.seriesToDTO(*got, base))
}

func (s *Server) handleGetSeriesThumbnail(w http.ResponseWriter, r *http.Request) {
	raw := readVideoIDParam(r)
	if raw == "" {
		http.NotFound(w, r)
		return
	}
	nid, sid, composite := parseCompositeID(raw)
	if !composite {
		sid = raw
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
	ser, err := s.store.GetSeries(r.Context(), sid)
	if err != nil || ser == nil || strings.TrimSpace(ser.ThumbRel) == "" {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(s.dataDir, filepath.FromSlash(ser.ThumbRel))
	st, err := os.Stat(full)
	if err != nil || st.Size() == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, full)
}
