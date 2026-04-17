//go:build !fyne

package ui

import (
	"context"

	"github.com/iol-challenge/youtube/backend-go/internal/api"
	"github.com/iol-challenge/youtube/backend-go/internal/config"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

// Start is a no-op unless built with -tags fyne.
func Start(_ context.Context, _ string, _ *config.Config, _ *store.Store, _ *api.Server, _ func([]string)) error {
	return nil
}

