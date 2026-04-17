package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Series es una serie local (carpeta lógica de vídeos).
type Series struct {
	ID          string
	Title       string
	Description string
	Genre       string
	Year        *int
	ThumbRel    string // relativo a data dir, ej. series/<id>.jpg
	CreatedAt   time.Time
}

// ListSeries devuelve todas las series ordenadas por título.
func (s *Store) ListSeries(ctx context.Context) ([]Series, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, title, description, genre, year, thumb_rel, created_at
FROM series ORDER BY title COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Series
	for rows.Next() {
		var x Series
		var y sql.NullInt64
		var created string
		if err := rows.Scan(&x.ID, &x.Title, &x.Description, &x.Genre, &y, &x.ThumbRel, &created); err != nil {
			return nil, err
		}
		if y.Valid {
			iy := int(y.Int64)
			x.Year = &iy
		}
		t, err := time.Parse(time.RFC3339Nano, created)
		if err != nil {
			x.CreatedAt = time.Now().UTC()
		} else {
			x.CreatedAt = t
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// GetSeries por id local.
func (s *Store) GetSeries(ctx context.Context, id string) (*Series, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, title, description, genre, year, thumb_rel, created_at
FROM series WHERE id = ?`, id)
	var x Series
	var y sql.NullInt64
	var created string
	err := row.Scan(&x.ID, &x.Title, &x.Description, &x.Genre, &y, &x.ThumbRel, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if y.Valid {
		iy := int(y.Int64)
		x.Year = &iy
	}
	t, err := time.Parse(time.RFC3339Nano, created)
	if err != nil {
		x.CreatedAt = time.Now().UTC()
	} else {
		x.CreatedAt = t
	}
	return &x, nil
}

// CreateSeries inserta una serie; si id está vacío se genera UUID.
func (s *Store) CreateSeries(ctx context.Context, in *Series) error {
	if strings.TrimSpace(in.Title) == "" {
		return fmt.Errorf("empty title")
	}
	if in.ID == "" {
		in.ID = uuid.NewString()
	}
	in.Title = strings.TrimSpace(in.Title)
	in.Description = strings.TrimSpace(in.Description)
	in.Genre = strings.TrimSpace(in.Genre)
	if in.CreatedAt.IsZero() {
		in.CreatedAt = time.Now().UTC()
	}
	var y sql.NullInt64
	if in.Year != nil {
		y = sql.NullInt64{Int64: int64(*in.Year), Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO series (id, title, description, genre, year, thumb_rel, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
		in.ID, in.Title, in.Description, in.Genre, y, strings.TrimSpace(in.ThumbRel), in.CreatedAt.UTC().Format(time.RFC3339Nano))
	return err
}
