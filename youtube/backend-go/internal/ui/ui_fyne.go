//go:build fyne

package ui

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync/atomic"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/iol-challenge/youtube/backend-go/internal/api"
	"github.com/iol-challenge/youtube/backend-go/internal/catalog"
	"github.com/iol-challenge/youtube/backend-go/internal/config"
	"github.com/iol-challenge/youtube/backend-go/internal/store"
)

func Start(ctx context.Context, configPath string, cfg *config.Config, st *store.Store, srv *api.Server, onRootsChanged func([]string)) error {
	a := app.NewWithID("com.iol.lanflix")
	a.Settings().SetTheme(theme.DarkTheme())

	w := a.NewWindow("LANflix - Configuración")
	w.Resize(fyne.NewSize(780, 520))

	roots := append([]string{}, cfg.LibraryRoots...)
	sort.Strings(roots)
	original := strings.Join(normalizeRoots(cfg.LibraryRoots), "\x00")

	var busy atomic.Bool
	status := widget.NewLabel("")

	nodeNameEntry := widget.NewEntry()
	nodeNameEntry.SetPlaceHolder("Ej: Living Room, kurt, PC-Sala…")
	nodeNameEntry.SetText(strings.TrimSpace(cfg.NodeName))

	list := widget.NewList(
		func() int { return len(roots) },
		func() fyne.CanvasObject { return widget.NewLabel("") },
		func(i widget.ListItemID, o fyne.CanvasObject) {
			o.(*widget.Label).SetText(roots[i])
		},
	)

	var selectedIdx int = -1
	list.OnSelected = func(id widget.ListItemID) { selectedIdx = int(id) }
	list.OnUnselected = func(_ widget.ListItemID) { selectedIdx = -1 }

	refreshList := func() {
		sort.Strings(roots)
		list.Refresh()
	}

	addBtn := widget.NewButtonWithIcon("Agregar carpeta…", theme.FolderOpenIcon(), func() {
		if busy.Load() {
			return
		}
		d := dialog.NewFolderOpen(func(uri fyne.ListableURI, err error) {
			if err != nil || uri == nil {
				return
			}
			p := filepath.Clean(uri.Path())
			for _, r := range roots {
				if r == p {
					status.SetText("La carpeta ya está agregada.")
					return
				}
			}
			roots = append(roots, p)
			refreshList()
			status.SetText("")
		}, w)
		d.Show()
	})

	rmBtn := widget.NewButtonWithIcon("Quitar", theme.DeleteIcon(), func() {
		if busy.Load() {
			return
		}
		if selectedIdx < 0 || selectedIdx >= len(roots) {
			return
		}
		roots = append(roots[:selectedIdx], roots[selectedIdx+1:]...)
		selectedIdx = -1
		refreshList()
	})

	saveAndApply := func(rescan bool) {
		if busy.Load() {
			return
		}
		cfg.NodeName = strings.TrimSpace(nodeNameEntry.Text)
		trimmed := make([]string, 0, len(roots))
		for _, r := range roots {
			r = strings.TrimSpace(r)
			if r != "" {
				trimmed = append(trimmed, r)
			}
		}
		normalized := normalizeRoots(trimmed)
		cfg.LibraryRoots = normalized
		if err := config.Save(configPath, cfg); err != nil {
			status.SetText("Error al guardar config: " + err.Error())
			return
		}
		onRootsChanged(normalized)
		srv.SetRoots(normalized)
		status.SetText("Config guardada.")
		changed := strings.Join(normalized, "\x00") != original
		if changed {
			// root_index depends on order; safest is to clear catalog whenever roots change.
			_ = st.ClearCatalog(ctx)
			_ = os.RemoveAll(filepath.Join(cfg.DataDir, "transcodes"))
			original = strings.Join(normalized, "\x00")
		}
		if !rescan && !changed {
			return
		}
		if len(normalized) == 0 {
			status.SetText("Config guardada. No hay carpetas para indexar.")
			return
		}
		busy.Store(true)
		status.SetText("Indexando…")
		go func() {
			defer busy.Store(false)
			_ = catalog.Scan(ctx, normalized, st)
			status.SetText("Indexado completo.")
		}()
	}

	saveBtn := widget.NewButtonWithIcon("Guardar", theme.DocumentSaveIcon(), func() { saveAndApply(false) })
	rescanBtn := widget.NewButtonWithIcon("Guardar y reindexar", theme.ViewRefreshIcon(), func() { saveAndApply(true) })
	clearBtn := widget.NewButtonWithIcon("Limpiar todo", theme.ContentClearIcon(), func() {
		if busy.Load() {
			return
		}
		dialog.ShowConfirm("Limpiar todo", "Esto borra el catálogo indexado, metadata y transcodes (no borra tus archivos). ¿Continuar?", func(ok bool) {
			if !ok {
				return
			}
			busy.Store(true)
			status.SetText("Limpiando…")
			go func() {
				defer busy.Store(false)
				_ = st.ClearCatalog(ctx)
				_ = os.RemoveAll(filepath.Join(cfg.DataDir, "transcodes"))
				status.SetText("Listo. Catálogo vacío.")
			}()
		}, w)
	})

	controls := container.NewVBox(
		addBtn,
		rmBtn,
		widget.NewSeparator(),
		saveBtn,
		rescanBtn,
		clearBtn,
	)

	content := container.NewBorder(
		container.NewVBox(
			widget.NewLabelWithStyle("Nodo", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
			container.NewGridWithColumns(2,
				widget.NewLabel("Nombre del nodo"),
				nodeNameEntry,
			),
			widget.NewSeparator(),
			widget.NewLabelWithStyle("Carpetas de videos (library_roots)", fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		),
		container.NewVBox(widget.NewSeparator(), status),
		nil,
		controls,
		list,
	)

	w.SetContent(content)

	go func() {
		<-ctx.Done()
		w.Close()
	}()

	w.Show()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("lanflix: panic en Fyne (a.Run): %v\n%s", r, debug.Stack())
		}
	}()
	a.Run()
	return nil
}

func normalizeRoots(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, r := range in {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		r = filepath.Clean(r)
		if _, ok := seen[r]; ok {
			continue
		}
		seen[r] = struct{}{}
		out = append(out, r)
	}
	sort.Strings(out)
	return out
}

