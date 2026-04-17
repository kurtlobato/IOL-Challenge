import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  getApiBase,
  getVideo,
  listVideos,
  requestTranscodeMp4,
  setApiBase,
  playbackOrigin,
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
        const one = await getVideo(urlVideoId);
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
          const updated = await getVideo(v.id);
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
          {items.map((v) => (
            <div
              key={v.id}
              className="video-card video-card-ready"
              style={{ position: "relative" }}
            >
              <div
                className="thumbnail"
                onClick={() => openWatch(v)}
                onMouseEnter={() => setPreviewId(v.id)}
                onMouseLeave={() => setPreviewId((cur) => (cur === v.id ? null : cur))}
              >
                {previewId === v.id ? (
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
                          el.currentTime = Math.min(3, Number.isFinite(el.duration) ? Math.max(0, el.duration - 0.25) : 3);
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
    </>
  );
}
