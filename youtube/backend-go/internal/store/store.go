package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Video struct {
	ID              string
	RelPath         string
	RootIndex       int
	Title           string
	SizeBytes       int64
	Mtime           time.Time
	ContentType     string
	DurationSeconds *float64
	IndexedAt       time.Time
}

type Store struct {
	db *sql.DB
}

type MediaInfo struct {
	VideoID    string
	Container  string
	VideoCodec string
	AudioCodec string
	PixFmt     string
	UpdatedAt  time.Time
}

type TranscodeInfo struct {
	VideoID    string
	Status     string // NONE|QUEUED|RUNNING|READY|FAILED
	Error      string
	OutputPath string // relative to data dir (e.g. transcodes/<id>.mp4)
	UpdatedAt  time.Time
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  root_index INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT '',
  duration_seconds REAL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videos_root_rel ON videos(root_index, rel_path);
CREATE TABLE IF NOT EXISTS video_views (
  video_id TEXT PRIMARY KEY,
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS video_media (
  video_id TEXT PRIMARY KEY,
  container TEXT NOT NULL DEFAULT '',
  video_codec TEXT NOT NULL DEFAULT '',
  audio_codec TEXT NOT NULL DEFAULT '',
  pix_fmt TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS video_transcodes (
  video_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NONE',
  error TEXT NOT NULL DEFAULT '',
  output_path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
`)
	return err
}

// UpsertVideo inserts or updates a catalog row.
func (s *Store) UpsertVideo(ctx context.Context, v *Video) error {
	mtimeNs := v.Mtime.UnixNano()
	var dur sql.NullFloat64
	if v.DurationSeconds != nil {
		dur = sql.NullFloat64{Float64: *v.DurationSeconds, Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO videos (id, root_index, rel_path, title, size_bytes, mtime_ns, content_type, duration_seconds, indexed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  root_index = excluded.root_index,
  rel_path = excluded.rel_path,
  title = excluded.title,
  size_bytes = excluded.size_bytes,
  mtime_ns = excluded.mtime_ns,
  content_type = excluded.content_type,
  duration_seconds = excluded.duration_seconds,
  indexed_at = excluded.indexed_at
`, v.ID, v.RootIndex, v.RelPath, v.Title, v.SizeBytes, mtimeNs, v.ContentType, dur, v.IndexedAt.UTC().Format(time.RFC3339Nano))
	return err
}

// ListVideos returns all videos ordered by mtime desc.
func (s *Store) ListVideos(ctx context.Context) ([]Video, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, root_index, rel_path, title, size_bytes, mtime_ns, content_type, duration_seconds, indexed_at
FROM videos ORDER BY mtime_ns DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		var v Video
		var mtimeNs int64
		var dur sql.NullFloat64
		var indexed string
		if err := rows.Scan(&v.ID, &v.RootIndex, &v.RelPath, &v.Title, &v.SizeBytes, &mtimeNs, &v.ContentType, &dur, &indexed); err != nil {
			return nil, err
		}
		v.Mtime = time.Unix(0, mtimeNs).UTC()
		if dur.Valid {
			f := dur.Float64
			v.DurationSeconds = &f
		}
		t, err := time.Parse(time.RFC3339Nano, indexed)
		if err != nil {
			v.IndexedAt = v.Mtime
		} else {
			v.IndexedAt = t
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) GetVideo(ctx context.Context, id string) (*Video, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, root_index, rel_path, title, size_bytes, mtime_ns, content_type, duration_seconds, indexed_at
FROM videos WHERE id = ?`, id)
	var v Video
	var mtimeNs int64
	var dur sql.NullFloat64
	var indexed string
	err := row.Scan(&v.ID, &v.RootIndex, &v.RelPath, &v.Title, &v.SizeBytes, &mtimeNs, &v.ContentType, &dur, &indexed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v.Mtime = time.Unix(0, mtimeNs).UTC()
	if dur.Valid {
		f := dur.Float64
		v.DurationSeconds = &f
	}
	t, err := time.Parse(time.RFC3339Nano, indexed)
	if err != nil {
		v.IndexedAt = v.Mtime
	} else {
		v.IndexedAt = t
	}
	return &v, nil
}

func (s *Store) RecordView(ctx context.Context, videoID string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `INSERT INTO video_views (video_id, view_count) VALUES (?, 1)
ON CONFLICT(video_id) DO UPDATE SET view_count = view_count + 1`, videoID)
	if err != nil {
		return 0, err
	}
	var c int64
	err = tx.QueryRowContext(ctx, `SELECT view_count FROM video_views WHERE video_id = ?`, videoID).Scan(&c)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return c, nil
}

func (s *Store) ViewCount(ctx context.Context, videoID string) (int64, error) {
	var c sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT view_count FROM video_views WHERE video_id = ?`, videoID).Scan(&c)
	if errors.Is(err, sql.ErrNoRows) || !c.Valid {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return c.Int64, nil
}

// DeleteVideo removes a catalog entry (file unchanged on disk).
func (s *Store) DeleteVideo(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM videos WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("not found")
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM video_views WHERE video_id = ?`, id)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM video_media WHERE video_id = ?`, id)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM video_transcodes WHERE video_id = ?`, id)
	return nil
}

// ClearCatalog removes all indexed videos and associated metadata.
func (s *Store) ClearCatalog(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
DELETE FROM video_views;
DELETE FROM video_media;
DELETE FROM video_transcodes;
DELETE FROM videos;
`)
	return err
}

func (s *Store) UpsertMediaInfo(ctx context.Context, m *MediaInfo) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO video_media (video_id, container, video_codec, audio_codec, pix_fmt, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(video_id) DO UPDATE SET
  container = excluded.container,
  video_codec = excluded.video_codec,
  audio_codec = excluded.audio_codec,
  pix_fmt = excluded.pix_fmt,
  updated_at = excluded.updated_at
`, m.VideoID, m.Container, m.VideoCodec, m.AudioCodec, m.PixFmt, m.UpdatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) GetMediaInfo(ctx context.Context, videoID string) (*MediaInfo, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT video_id, container, video_codec, audio_codec, pix_fmt, updated_at
FROM video_media WHERE video_id = ?`, videoID)
	var m MediaInfo
	var updated string
	err := row.Scan(&m.VideoID, &m.Container, &m.VideoCodec, &m.AudioCodec, &m.PixFmt, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t, err := time.Parse(time.RFC3339Nano, updated)
	if err == nil {
		m.UpdatedAt = t
	}
	return &m, nil
}

func (s *Store) UpsertTranscodeInfo(ctx context.Context, tc *TranscodeInfo) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO video_transcodes (video_id, status, error, output_path, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(video_id) DO UPDATE SET
  status = excluded.status,
  error = excluded.error,
  output_path = excluded.output_path,
  updated_at = excluded.updated_at
`, tc.VideoID, tc.Status, tc.Error, tc.OutputPath, tc.UpdatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) GetTranscodeInfo(ctx context.Context, videoID string) (*TranscodeInfo, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT video_id, status, error, output_path, updated_at
FROM video_transcodes WHERE video_id = ?`, videoID)
	var tc TranscodeInfo
	var updated string
	err := row.Scan(&tc.VideoID, &tc.Status, &tc.Error, &tc.OutputPath, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t, err := time.Parse(time.RFC3339Nano, updated)
	if err == nil {
		tc.UpdatedAt = t
	}
	return &tc, nil
}
