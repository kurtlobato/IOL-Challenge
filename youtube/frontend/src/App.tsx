import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  createSeries,
  getApiBase,
  getVideo,
  hideVideo,
  listNodes,
  listSeries,
  listVideos,
  ownerNodeIdFromVideoId,
  patchVideo,
  requestTranscodeMp4,
  setApiBase,
  playbackOrigin,
  type SeriesItem,
  type VideoItem,
} from "./api";
import { VideoPlayer } from "./VideoPlayer";
import { formatRelativeUploadDate } from "./formatUploadDate";
import { formatVideoDurationHms, formatViewsLine } from "./formatYoutubeStats";
import "./App.css";

function parseWatchId(pathname: string): string | undefined {
  const m = pathname.match(/^\/watch\/(.+)$/);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function needsTranscodeCta(v: VideoItem): boolean {
  return v.compat?.browserPlayable === false && v.transcode?.status !== "READY";
}

function transcodeOverlayAlwaysVisible(v: VideoItem, activeTranscodeId: string | null): boolean {
  if (v.transcode?.status === "QUEUED" || v.transcode?.status === "RUNNING") return true;
  if (activeTranscodeId === v.id) return true;
  return false;
}

function transcodeOverlayLabel(v: VideoItem, activeTranscodeId: string | null): string {
  if (v.transcode?.status === "RUNNING") return "Transcodificando…";
  if (v.transcode?.status === "QUEUED") return "En espera para transcodificación";
  if (activeTranscodeId === v.id) return "En espera para transcodificación";
  return "Transcodificar";
}

function canHoverPreviewVideo(v: VideoItem): boolean {
  if (v.transcode?.status === "READY" && v.transcode?.mp4Url) return true;
  if (v.compat?.browserPlayable === false) return false;
  return Boolean(v.streamUrl);
}

type DashboardGroup = { key: string; label: string | null; items: VideoItem[] };

function groupForDashboard(items: VideoItem[]): DashboardGroup[] {
  const bySeries = new Map<string, VideoItem[]>();
  const titleBySeries = new Map<string, string>();
  const noSeries: VideoItem[] = [];
  for (const v of items) {
    const sid = v.series?.id;
    if (!sid) {
      noSeries.push(v);
      continue;
    }
    if (!titleBySeries.has(sid)) {
      titleBySeries.set(sid, v.series?.title ?? sid);
    }
    if (!bySeries.has(sid)) bySeries.set(sid, []);
    bySeries.get(sid)!.push(v);
  }
  const orderedIds = [...bySeries.keys()].sort((a, b) =>
    (titleBySeries.get(a) ?? "").localeCompare(titleBySeries.get(b) ?? "", "es"),
  );
  const out: DashboardGroup[] = orderedIds.map((id) => ({
    key: id,
    label: titleBySeries.get(id) ?? id,
    items: bySeries.get(id)!,
  }));
  if (noSeries.length) {
    out.push({ key: "sin-serie", label: null, items: noSeries });
  }
  return out;
}

type VideoEditDraft = {
  title: string;
  description: string;
  genre: string;
  yearStr: string;
  seriesId: string;
};

export default function App() {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [federated, setFederated] = useState(true);
  const [seedDraft, setSeedDraft] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredNode[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VideoItem | null>(null);
  const [myViewerKey, setMyViewerKey] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [cardMenu, setCardMenu] = useState<{
    x: number;
    y: number;
    video: VideoItem;
  } | null>(null);
  const [videoEdit, setVideoEdit] = useState<{
    video: VideoItem;
    draft: VideoEditDraft;
  } | null>(null);
  const [seriesList, setSeriesList] = useState<SeriesItem[]>([]);
  const [seriesCreateOpen, setSeriesCreateOpen] = useState(false);
  const [newSeriesDraft, setNewSeriesDraft] = useState({
    title: "",
    description: "",
    genre: "",
    yearStr: "",
    thumb: null as File | null,
  });
  const cardMenuRef = useRef<HTMLDivElement | null>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const urlVideoId = parseWatchId(location.pathname);

  useEffect(() => {
    let saved = localStorage.getItem("iol_uploader_id");
    if (!saved) {
      saved = "user_" + Math.random().toString(36).substring(2, 10);
      localStorage.setItem("iol_uploader_id", saved);
    }
    setMyViewerKey(saved);
  }, []);

  useEffect(() => {
    setSeedDraft(getApiBase());
  }, []);

  const refreshDiscovery = useCallback(async () => {
    if (!window.lanflix) return;
    try {
      setDiscoveryError(null);
      const nodes = await window.lanflix.listNodes();
      setDiscovered(nodes);
      if (nodes.length > 0 && !getApiBase().trim()) {
        setSeedDraft(nodes[0].baseUrl);
        setApiBase(nodes[0].baseUrl);
      }
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!window.lanflix) return;
    const unsub = window.lanflix.onNodesChanged((nodes) => {
      setDiscovered(nodes);
      if (nodes.length > 0 && !getApiBase().trim()) {
        setSeedDraft(nodes[0].baseUrl);
        setApiBase(nodes[0].baseUrl);
      }
    });
    return () => unsub?.();
  }, []);

  const refresh = useCallback(
    async (opts?: { silent?: boolean; retries?: number }) => {
      const silent = opts?.silent ?? false;
      const retries = Math.max(1, opts?.retries ?? 1);
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      let lastErr: unknown;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const list = await listVideos({ federated });
          setItems(list);
          setSelected((cur) => {
            if (!cur) return cur;
            const u = list.find((v) => v.id === cur.id);
            return u ?? cur;
          });
          if (!silent) setLoading(false);
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < retries - 1) {
            await new Promise((r) => setTimeout(r, 320 * (attempt + 1)));
          }
        }
      }
      if (!silent) {
        setError(lastErr instanceof Error ? lastErr.message : String(lastErr));
        setLoading(false);
      }
    },
    [federated],
  );

  /** Primera carga: en Electron espera a semilla mDNS (o timeout) y reintenta el fetch. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (window.lanflix) {
        await refreshDiscovery();
        if (cancelled) return;
        if (!getApiBase().trim()) {
          const deadline = Date.now() + 3200;
          while (!cancelled && !getApiBase().trim() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      }
      if (cancelled) return;
      await refresh({ silent: false, retries: window.lanflix ? 4 : 1 });
    })();
    return () => {
      cancelled = true;
    };
  }, [federated, refresh, refreshDiscovery]);

  /** Refresco periódico sin spinner ni borrar el resto del estado. */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refresh({ silent: true, retries: 2 });
    }, 45_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (!urlVideoId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await listVideos({ federated });
        if (cancelled) return;
        const fromList = list.find((v) => v.id === urlVideoId);
        if (fromList) {
          setSelected(fromList);
          return;
        }
        let ownerOrigin: string | null = null;
        const ownerNid = ownerNodeIdFromVideoId(urlVideoId);
        if (ownerNid) {
          try {
            const nodes = await listNodes(12);
            const n = nodes.find((x) => x.nodeId === ownerNid);
            if (n?.baseUrl) {
              ownerOrigin = new URL(n.baseUrl).origin;
            }
          } catch {
            // sin grafo de nodos: se intenta solo el semilla
          }
        }
        const one = await getVideo(urlVideoId, ownerOrigin);
        if (cancelled) return;
        setSelected(one);
        setItems((prev) => {
          if (prev.some((x) => x.id === one.id)) return prev.map((x) => (x.id === one.id ? one : x));
          return [one, ...prev];
        });
      } catch {
        if (!cancelled) navigate("/", { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlVideoId, federated, navigate]);

  const viewKey = selected ? selected.id : "home";
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [viewKey]);

  const patchViewCount = useCallback((id: string, viewCount: number) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, viewCount } : x)));
    setSelected((cur) => (cur?.id === id ? { ...cur, viewCount } : cur));
  }, []);

  const [transcodingId, setTranscodingId] = useState<string | null>(null);

  const startTranscode = useCallback(
    async (v: VideoItem) => {
      if (!v.streamUrl) return;
      setTranscodingId(v.id);
      try {
        const origin = playbackOrigin(v.streamUrl);
        await requestTranscodeMp4(v.id, origin);
        // Poll until READY/FAILED.
        for (let i = 0; i < 240; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const updated = await getVideo(
            v.id,
            playbackOrigin(v.streamUrl) || null,
          );
          setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
          setSelected((cur) => (cur?.id === updated.id ? updated : cur));
          const st = updated.transcode?.status;
          if (st === "READY" || st === "FAILED") break;
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setTranscodingId(null);
      }
    },
    [getVideo],
  );

  function saveSeed() {
    setApiBase(seedDraft);
    void refresh({ silent: false, retries: 3 });
  }

  function openWatch(v: VideoItem) {
    navigate(`/watch/${encodeURIComponent(v.id)}`);
  }

  const closeWatch = useCallback(() => {
    navigate("/", { replace: false });
  }, [navigate]);

  useEffect(() => {
    if (!cardMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = cardMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setCardMenu(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCardMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [cardMenu]);

  const confirmHideVideo = useCallback(
    async (v: VideoItem) => {
      if (
        !window.confirm(
          `¿Ocultar «${v.title}» de la biblioteca? El archivo no se borra del disco.`,
        )
      ) {
        return;
      }
      try {
        await hideVideo(v.id, playbackOrigin(v.streamUrl) || null);
        setCardMenu(null);
        setItems((prev) => prev.filter((x) => x.id !== v.id));
        if (urlVideoId === v.id) {
          navigate("/", { replace: true });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [navigate, urlVideoId],
  );

  const commitVideoEdit = useCallback(async () => {
    const cur = videoEdit;
    if (!cur) return;
    const t = cur.draft.title.trim();
    if (!t) return;
    let year: number | null = null;
    if (cur.draft.yearStr.trim() !== "") {
      const y = Number.parseInt(cur.draft.yearStr, 10);
      if (!Number.isFinite(y)) {
        setError("Año inválido");
        return;
      }
      year = y;
    }
    try {
      const updated = await patchVideo(
        cur.video.id,
        {
          title: t,
          description: cur.draft.description,
          genre: cur.draft.genre,
          year,
          seriesId: cur.draft.seriesId.trim() !== "" ? cur.draft.seriesId.trim() : null,
        },
        playbackOrigin(cur.video.streamUrl) || null,
      );
      setVideoEdit(null);
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setSelected((sel) => (sel?.id === updated.id ? updated : sel));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [videoEdit]);

  useEffect(() => {
    if (!videoEdit) {
      setSeriesList([]);
      return;
    }
    const origin = playbackOrigin(videoEdit.video.streamUrl);
    let cancelled = false;
    void listSeries(origin || null)
      .then((list) => {
        if (!cancelled) setSeriesList(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoEdit]);

  useEffect(() => {
    if (!seriesCreateOpen && !videoEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (seriesCreateOpen) setSeriesCreateOpen(false);
      else if (videoEdit) setVideoEdit(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [seriesCreateOpen, videoEdit]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeWatch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, closeWatch]);

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand" onClick={() => navigate("/")}>
          <img className="navbar-logo" src="/favicon-32.png" alt="" width={28} height={28} />
          LANflix
        </div>
        <div className="navbar-seed" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ color: "#aaa", fontSize: "0.85rem" }}>Nodo semilla</label>
          <input
            type="url"
            placeholder="http://IP:8080 (vacío = mismo origen)"
            value={seedDraft}
            onChange={(e) => setSeedDraft(e.target.value)}
            style={{
              minWidth: 200,
              maxWidth: 360,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #3a3a3a",
              background: "#212121",
              color: "#f1f1f1",
            }}
          />
          <button type="button" className="btn-create" onClick={() => saveSeed()}>
            Guardar
          </button>
          {window.lanflix ? (
            <>
              <button
                type="button"
                className="btn-modal-secondary"
                onClick={() => void refreshDiscovery()}
                disabled={loading}
                title="Descubrir nodos LAN (mDNS)"
              >
                Descubrir
              </button>
              {discovered.length > 0 ? (
                <select
                  value={seedDraft}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSeedDraft(v);
                    setApiBase(v);
                    void refresh({ silent: false, retries: 3 });
                  }}
                  aria-label="Nodos descubiertos"
                  style={{
                    maxWidth: 260,
                    padding: "6px 10px",
                    borderRadius: 6,
                    background: "#272727",
                    color: "#f1f1f1",
                    border: "1px solid #3a3a3a",
                  }}
                >
                  {discovered.map((n) => (
                    <option key={n.nodeId} value={n.baseUrl}>
                      {n.name} ({n.baseUrl})
                    </option>
                  ))}
                </select>
              ) : null}
            </>
          ) : null}
          <label style={{ color: "#aaa", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={federated}
              onChange={(e) => setFederated(e.target.checked)}
            />
            Federar red
          </label>
          <button
            type="button"
            className="btn-modal-secondary"
            onClick={() => void refresh({ silent: false, retries: 3 })}
            disabled={loading}
          >
            {loading ? "…" : "Actualizar"}
          </button>
        </div>
      </nav>

      {error ? (
        <p className="err" style={{ padding: "16px 24px", margin: 0 }}>
          {error}
        </p>
      ) : null}
      {discoveryError ? (
        <p className="err" style={{ padding: "0 24px 16px", margin: 0 }}>
          Discovery: {discoveryError}
        </p>
      ) : null}

      {selected ? (
        <main className="watch-overlay" role="dialog" aria-label="Reproducción" aria-modal="true">
          <div className="watch-topbar">
            <button type="button" className="watch-back" onClick={() => closeWatch()} aria-label="Volver">
              ←
            </button>
            <div className="watch-title">
              <div className="watch-title-main">{selected.title}</div>
              <div className="watch-title-sub">
                {(selected.nodeName && selected.nodeName.trim() !== ""
                  ? selected.nodeName
                  : selected.nodeId.slice(0, 8) + "…")}
              </div>
            </div>
            <div className="watch-topbar-right">
              {selected.compat?.browserPlayable === false && selected.transcode?.status !== "READY" ? (
                <>
                  <span className="watch-warn">
                    No compatible ({selected.compat.reason ?? "formato no soportado"})
                  </span>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={transcodingId === selected.id}
                    onClick={() => void startTranscode(selected)}
                  >
                    {transcodingId === selected.id ? "Transcodificando…" : "Transcodificar a MP4"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div className="watch-player">
            {selected.status === "READY" &&
            (selected.transcode?.status === "READY" ? selected.transcode?.mp4Url : selected.streamUrl) ? (
              <VideoPlayer
                streamUrl={
                  selected.transcode?.status === "READY" && selected.transcode?.mp4Url
                    ? selected.transcode.mp4Url
                    : selected.streamUrl
                }
                manifestUrl={selected.manifestUrl}
                videoId={selected.id}
                viewerKey={myViewerKey}
                durationSeconds={selected.durationSeconds}
                viewApiOrigin={playbackOrigin(selected.streamUrl)}
                onViewCountUpdated={(c) => patchViewCount(selected.id, c)}
                title={selected.title}
                onBack={closeWatch}
              />
            ) : (
              <div className="watch-placeholder">
                <span className={selected.status === "FAILED" ? "err" : ""}>
                  {selected.status === "FAILED" ? `Error (${selected.errorMessage})` : selected.status}
                </span>
              </div>
            )}
          </div>
        </main>
      ) : (
        <main className="dashboard">
          {groupForDashboard(items).map((g) => (
            <Fragment key={g.key}>
              {g.label ? (
                <div className="series-section-title" role="heading" aria-level={2}>
                  {g.label}
                </div>
              ) : null}
              {g.items.map((v) => (
            <div
              key={v.id}
              className={
                "video-card video-card-ready" + (needsTranscodeCta(v) ? " video-card--incompat" : "")
              }
              style={{ position: "relative" }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCardMenu({ x: e.clientX, y: e.clientY, video: v });
              }}
            >
              <div
                className="thumbnail"
                onClick={() => openWatch(v)}
                onMouseEnter={() => setPreviewId(v.id)}
                onMouseLeave={() => setPreviewId((cur) => (cur === v.id ? null : cur))}
              >
                {previewId === v.id && canHoverPreviewVideo(v) ? (
                  <div className="thumbnail-preview-wrap">
                    <video
                      className="thumbnail-preview-video"
                      muted
                      playsInline
                      preload="metadata"
                      loop
                      autoPlay
                      src={
                        v.transcode?.status === "READY" && v.transcode?.mp4Url
                          ? v.transcode.mp4Url
                          : v.streamUrl
                      }
                      onLoadedMetadata={(e) => {
                        const el = e.currentTarget;
                        try {
                          el.currentTime = Math.min(
                            3,
                            Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.25) : 3,
                          );
                        } catch {
                          // ignore
                        }
                      }}
                      onCanPlay={(e) => {
                        void e.currentTarget.play().catch(() => {});
                      }}
                    />
                  </div>
                ) : null}
                {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" loading="lazy" /> : null}
                <span className={`thumb-fallback${v.thumbnailUrl ? " is-hidden" : ""}`} aria-hidden>
                  ▶
                </span>
                {v.durationSeconds != null &&
                Number.isFinite(v.durationSeconds) &&
                v.durationSeconds > 0 ? (
                  <span className="thumb-duration">{formatVideoDurationHms(v.durationSeconds)}</span>
                ) : null}
                {needsTranscodeCta(v) ? (
                  <div
                    className={
                      "card-transcode-overlay" +
                      (transcodeOverlayAlwaysVisible(v, transcodingId)
                        ? " card-transcode-overlay--forced"
                        : "") +
                      (v.transcode?.status === "QUEUED" ||
                      v.transcode?.status === "RUNNING" ||
                      transcodingId === v.id
                        ? " card-transcode-overlay--busy"
                        : "")
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      const st = v.transcode?.status;
                      if (st === "QUEUED" || st === "RUNNING") return;
                      void startTranscode(v);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.stopPropagation();
                      e.preventDefault();
                      const st = v.transcode?.status;
                      if (st === "QUEUED" || st === "RUNNING") return;
                      void startTranscode(v);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={transcodeOverlayLabel(v, transcodingId)}
                  >
                    <span className="card-transcode-overlay-text">
                      {transcodeOverlayLabel(v, transcodingId)}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="card-info">
                <div className="avatar">▶</div>
                <div className="card-text">
                  <div className="card-title-row">
                    <h3 className="card-title" onClick={() => openWatch(v)}>
                      {v.title}
                    </h3>
                  </div>
                  <p className="card-meta card-channel-row">
                    <span title={v.nodeName ?? v.nodeId}>
                      {v.nodeName && v.nodeName.trim() !== ""
                        ? v.nodeName
                        : `Nodo ${v.nodeId.slice(0, 8)}…`}
                    </span>
                    {v.compat?.browserPlayable === false &&
                    v.transcode?.status !== "READY" ? (
                      <span style={{ marginLeft: 8, color: "#f28b82" }} title={v.compat.reason ?? ""}>
                        No compatible
                      </span>
                    ) : null}
                  </p>
                  <p className="card-meta card-views-row">
                    {`${formatViewsLine(v.viewCount ?? 0)} • ${formatRelativeUploadDate(v.createdAt)}`}
                  </p>
                </div>
              </div>
            </div>
              ))}
            </Fragment>
          ))}
          {items.length === 0 && !loading && (
            <div
              style={{
                gridColumn: "1 / -1",
                textAlign: "center",
                padding: "40px",
                color: "#aaa",
                fontSize: "1.2rem",
              }}
            >
              No hay videos indexados. Configurá las carpetas en el backend y pulsá Actualizar.
            </div>
          )}
        </main>
      )}
      {cardMenu ? (
        <div
          ref={cardMenuRef}
          className="card-context-menu"
          style={{
            left: Math.max(
              8,
              Math.min(cardMenu.x, window.innerWidth - 228),
            ),
            top: Math.max(
              8,
              Math.min(cardMenu.y, window.innerHeight - 140),
            ),
          }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const v = cardMenu.video;
            const tcBusy =
              v.transcode?.status === "QUEUED" ||
              v.transcode?.status === "RUNNING" ||
              transcodingId === v.id;
            const canTranscode = needsTranscodeCta(v) && !tcBusy;
            return (
              <>
                <button
                  type="button"
                  className="card-context-menu__item"
                  role="menuitem"
                  onClick={() => {
                    setVideoEdit({
                      video: v,
                      draft: {
                        title: v.title,
                        description: v.description ?? "",
                        genre: v.genre ?? "",
                        yearStr: v.year != null ? String(v.year) : "",
                        seriesId: v.series?.id ?? "",
                      },
                    });
                    setCardMenu(null);
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="card-context-menu__item"
                  role="menuitem"
                  disabled={!canTranscode}
                  title={
                    !needsTranscodeCta(v)
                      ? "Solo si el formato no es compatible con el navegador"
                      : tcBusy
                        ? "Transcodificación en curso"
                        : undefined
                  }
                  onClick={() => {
                    if (!canTranscode) return;
                    setCardMenu(null);
                    void startTranscode(v);
                  }}
                >
                  Transcodificar
                </button>
                <button
                  type="button"
                  className="card-context-menu__item card-context-menu__item--danger"
                  role="menuitem"
                  onClick={() => void confirmHideVideo(v)}
                >
                  Eliminar
                </button>
              </>
            );
          })()}
        </div>
      ) : null}
      {videoEdit ? (
        <div
          className="modal-overlay title-edit-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="video-edit-heading"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setVideoEdit(null);
          }}
        >
          <div className="modal-content video-edit-modal">
            <div className="modal-header" id="video-edit-heading">
              Editar vídeo
              <button
                type="button"
                className="btn-close"
                aria-label="Cerrar"
                onClick={() => setVideoEdit(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body video-edit-body">
              <label className="video-edit-label">
                Título
                <input
                  type="text"
                  className="title-edit-input"
                  value={videoEdit.draft.title}
                  onChange={(e) =>
                    setVideoEdit((cur) =>
                      cur ? { ...cur, draft: { ...cur.draft, title: e.target.value } } : cur,
                    )
                  }
                />
              </label>
              <label className="video-edit-label">
                Descripción
                <textarea
                  className="video-edit-textarea"
                  rows={3}
                  value={videoEdit.draft.description}
                  onChange={(e) =>
                    setVideoEdit((cur) =>
                      cur ? { ...cur, draft: { ...cur.draft, description: e.target.value } } : cur,
                    )
                  }
                />
              </label>
              <div className="video-edit-row">
                <label className="video-edit-label video-edit-label--half">
                  Género
                  <input
                    type="text"
                    className="title-edit-input"
                    value={videoEdit.draft.genre}
                    onChange={(e) =>
                      setVideoEdit((cur) =>
                        cur ? { ...cur, draft: { ...cur.draft, genre: e.target.value } } : cur,
                      )
                    }
                  />
                </label>
                <label className="video-edit-label video-edit-label--half">
                  Año
                  <input
                    type="text"
                    className="title-edit-input"
                    inputMode="numeric"
                    placeholder="ej. 2024"
                    value={videoEdit.draft.yearStr}
                    onChange={(e) =>
                      setVideoEdit((cur) =>
                        cur ? { ...cur, draft: { ...cur.draft, yearStr: e.target.value } } : cur,
                      )
                    }
                  />
                </label>
              </div>
              <label className="video-edit-label">
                Serie
                <select
                  className="video-edit-select"
                  value={videoEdit.draft.seriesId}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "__new__") {
                      setNewSeriesDraft({
                        title: "",
                        description: "",
                        genre: "",
                        yearStr: "",
                        thumb: null,
                      });
                      setSeriesCreateOpen(true);
                      return;
                    }
                    setVideoEdit((cur) =>
                      cur ? { ...cur, draft: { ...cur.draft, seriesId: val } } : cur,
                    );
                  }}
                >
                  <option value="">Ninguna</option>
                  {seriesList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                  <option value="__new__">+ Agregar nueva serie…</option>
                </select>
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-modal-secondary"
                  onClick={() => setVideoEdit(null)}
                >
                  Cancelar
                </button>
                <button type="button" className="btn-primary" onClick={() => void commitVideoEdit()}>
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {seriesCreateOpen && videoEdit ? (
        <div
          className="modal-overlay series-create-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="series-create-heading"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSeriesCreateOpen(false);
          }}
        >
          <div className="modal-content video-edit-modal">
            <div className="modal-header" id="series-create-heading">
              Nueva serie
              <button
                type="button"
                className="btn-close"
                aria-label="Cerrar"
                onClick={() => setSeriesCreateOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body video-edit-body">
              <label className="video-edit-label">
                Título
                <input
                  type="text"
                  className="title-edit-input"
                  value={newSeriesDraft.title}
                  onChange={(e) => setNewSeriesDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </label>
              <label className="video-edit-label">
                Descripción
                <textarea
                  className="video-edit-textarea"
                  rows={3}
                  value={newSeriesDraft.description}
                  onChange={(e) =>
                    setNewSeriesDraft((d) => ({ ...d, description: e.target.value }))
                  }
                />
              </label>
              <div className="video-edit-row">
                <label className="video-edit-label video-edit-label--half">
                  Género
                  <input
                    type="text"
                    className="title-edit-input"
                    value={newSeriesDraft.genre}
                    onChange={(e) => setNewSeriesDraft((d) => ({ ...d, genre: e.target.value }))}
                  />
                </label>
                <label className="video-edit-label video-edit-label--half">
                  Año
                  <input
                    type="text"
                    className="title-edit-input"
                    inputMode="numeric"
                    value={newSeriesDraft.yearStr}
                    onChange={(e) => setNewSeriesDraft((d) => ({ ...d, yearStr: e.target.value }))}
                  />
                </label>
              </div>
              <label className="video-edit-label">
                Miniatura
                <input
                  type="file"
                  accept="image/*"
                  className="video-edit-file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    setNewSeriesDraft((d) => ({ ...d, thumb: f ?? null }));
                  }}
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-modal-secondary"
                  onClick={() => setSeriesCreateOpen(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    void (async () => {
                      const t = newSeriesDraft.title.trim();
                      if (!t) return;
                      try {
                        const fd = new FormData();
                        fd.append("title", t);
                        fd.append("description", newSeriesDraft.description.trim());
                        fd.append("genre", newSeriesDraft.genre.trim());
                        if (newSeriesDraft.yearStr.trim() !== "") {
                          fd.append("year", newSeriesDraft.yearStr.trim());
                        }
                        if (newSeriesDraft.thumb) {
                          fd.append("thumbnail", newSeriesDraft.thumb);
                        }
                        const origin = playbackOrigin(videoEdit.video.streamUrl);
                        const created = await createSeries(fd, origin || null);
                        setSeriesList((p) =>
                          [...p, created].sort((a, b) => a.title.localeCompare(b.title, "es")),
                        );
                        setVideoEdit((ve) =>
                          ve ? { ...ve, draft: { ...ve.draft, seriesId: created.id } } : ve,
                        );
                        setSeriesCreateOpen(false);
                        setNewSeriesDraft({
                          title: "",
                          description: "",
                          genre: "",
                          yearStr: "",
                          thumb: null,
                        });
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    })();
                  }}
                >
                  Guardar serie
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
