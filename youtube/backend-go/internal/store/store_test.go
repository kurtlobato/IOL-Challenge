package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUpsertAndList(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "t.db")
	s, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	id := uuid.NewString()
	now := time.Now().UTC()
	v := &Video{
		ID:        id,
		RelPath:   "a/b.mp4",
		RootIndex: 0,
		Title:     "hello",
		SizeBytes: 10,
		Mtime:     now,
		ContentType: "video/mp4",
		IndexedAt: now,
	}
	if err := s.UpsertVideo(ctx, v); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListVideos(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("list: %+v", list)
	}
	got, err := s.GetVideo(ctx, id)
	if err != nil || got == nil || got.Title != "hello" {
		t.Fatalf("get: %v %+v", err, got)
	}
	c, err := s.RecordView(ctx, id)
	if err != nil || c != 1 {
		t.Fatalf("view: %v %d", err, c)
	}
	c2, err := s.RecordView(ctx, id)
	if err != nil || c2 != 2 {
		t.Fatalf("view2: %v %d", err, c2)
	}
	if err := s.DeleteVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	list2, _ := s.ListVideos(ctx)
	if len(list2) != 0 {
		t.Fatalf("after delete: %d", len(list2))
	}
}

func TestHideVideo(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "hide.db")
	s, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	id := uuid.NewString()
	now := time.Now().UTC()
	v := &Video{
		ID:          id,
		RelPath:     "x.mp4",
		RootIndex:   0,
		Title:       "t",
		SizeBytes:   1,
		Mtime:       now,
		ContentType: "video/mp4",
		IndexedAt:   now,
	}
	if err := s.UpsertVideo(ctx, v); err != nil {
		t.Fatal(err)
	}
	if err := s.HideVideo(ctx, id); err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListVideos(ctx)
	if len(list) != 0 {
		t.Fatalf("expected hidden excluded from list, got %d", len(list))
	}
	got, _ := s.GetVideo(ctx, id)
	if got != nil {
		t.Fatal("GetVideo should hide hidden rows")
	}
}
