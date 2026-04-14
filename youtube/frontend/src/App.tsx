import { useCallback, useEffect, useId, useRef, useState } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import {
  completeVideo,
  createVideo,
  getVideo,
  getOriginalDownloadLink,
  listVideos,
  uploadToPresigned,
  deleteVideo,
  updateVideoTitle,
  type VideoItem,
} from "./api";
import { VideoPlayer } from "./VideoPlayer";
import { VideoHoverPreview } from "./VideoHoverPreview";
import { formatFullUploadDateDetail, formatRelativeUploadDate } from "./formatUploadDate";
import { formatVideoDurationHms, formatViewsLine } from "./formatYoutubeStats";
import { downloadFromUrl } from "./downloadFromUrl";
import "./App.css";

export default function App() {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  
  const [selected, setSelected] = useState<VideoItem | null>(null);
  const [hoverPreviewId, setHoverPreviewId] = useState<string | null>(null);
  const [cardMenuOpenId, setCardMenuOpenId] = useState<string | null>(null);
  const [editModalVideo, setEditModalVideo] = useState<VideoItem | null>(null);
  const [editDraftTitle, setEditDraftTitle] = useState("");
  const [editModalError, setEditModalError] = useState<string | null>(null);
  const [editModalSaving, setEditModalSaving] = useState(false);
  const [deleteModalVideo, setDeleteModalVideo] = useState<VideoItem | null>(null);
  const [deleteModalError, setDeleteModalError] = useState<string | null>(null);
  const [deleteModalDeleting, setDeleteModalDeleting] = useState(false);
  const [downloadBusyId, setDownloadBusyId] = useState<string | null>(null);
  const hoverPreviewTimeById = useRef<Map<string, number>>(new Map());
  /** Reintentos de subida (mismo archivo) reutilizan el mismo CREATED en API. */
  const uploadIdempotencyKeyRef = useRef<string | null>(null);
  /** Subida en curso (para abortar al borrar el mismo video). */
  const uploadSessionRef = useRef<{ videoId: string; abort: AbortController } | null>(null);
  const fileInputId = useId();
  const editTitleInputId = useId();
  const location = useLocation();
  const navigate = useNavigate();
  const urlVideoId =
    matchPath({ path: "/watch/:videoId", end: true }, location.pathname)?.params.videoId ?? undefined;

  // Generamos un ID de usuario descartable para esta sesión/navegador
  const [myUploaderId, setMyUploaderId] = useState<string>("");

  useEffect(() => {
    let saved = localStorage.getItem("iol_uploader_id");
    if (!saved) {
      saved = "user_" + Math.random().toString(36).substring(2, 10);
      localStorage.setItem("iol_uploader_id", saved);
    }
    setMyUploaderId(saved);
  }, []);

  const refresh = useCallback(async () => {
    const list = await listVideos();
    setItems(list);
    setSelected((cur) => {
      if (!cur) return cur;
      const u = list.find((v) => v.id === cur.id);
      return u ?? cur;
    });
  }, []);

  useEffect(() => {
    refresh().catch((e) => console.error(e));
  }, [refresh]);

  useEffect(() => {
    uploadIdempotencyKeyRef.current = null;
  }, [file]);

  useEffect(() => {
    if (!urlVideoId) {
      setSelected(null);
      return;
    }
    const fromList = items.find((v) => v.id === urlVideoId);
    if (fromList) {
      setSelected(fromList);
      return;
    }
    let cancelled = false;
    void getVideo(urlVideoId)
      .then((v) => {
        if (cancelled) return;
        setSelected(v);
        setItems((prev) => {
          if (prev.some((x) => x.id === v.id)) return prev.map((x) => (x.id === v.id ? v : x));
          return [v, ...prev];
        });
      })
      .catch(() => {
        if (!cancelled) navigate("/", { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [urlVideoId, items, navigate]);

  const viewKey = selected ? selected.id : "home";
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [viewKey]);

  useEffect(() => {
    if (!cardMenuOpenId) return;
    const close = () => setCardMenuOpenId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [cardMenuOpenId]);

  const patchViewCount = useCallback((id: string, viewCount: number) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, viewCount } : x)));
    setSelected((cur) => (cur?.id === id ? { ...cur, viewCount } : cur));
  }, []);

  useEffect(() => {
    if (!selected) return;
    if (selected.status !== "UPLOADED" && selected.status !== "PROCESSING") return;
    const id = window.setInterval(() => {
      refresh().catch((e) => console.error(e));
    }, 2000);
    return () => window.clearInterval(id);
  }, [selected?.id, selected?.status, refresh]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setLoading(true);
    setUploadPercent(0);
    try {
      let idem = uploadIdempotencyKeyRef.current;
      if (!idem) {
        idem = crypto.randomUUID();
        uploadIdempotencyKeyRef.current = idem;
      }
      const created = await createVideo({
        title: title.trim() || "Sin título",
        originalFilename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        uploaderId: myUploaderId,
        uploadIdempotencyKey: idem,
      });
      const ac = new AbortController();
      uploadSessionRef.current = { videoId: created.id, abort: ac };
      await uploadToPresigned(created.uploadUrl, file, created.method, (p) =>
        setUploadPercent(p),
        ac.signal,
      );
      await completeVideo(created.id);
      uploadIdempotencyKeyRef.current = null;
      await refresh();

      setIsModalOpen(false); // Close on success
      setTitle("");
      setFile(null);

      pollUntilDone(created.id);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        uploadIdempotencyKeyRef.current = null;
        await refresh().catch(() => {});
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      uploadSessionRef.current = null;
      setLoading(false);
      setUploadPercent(null);
    }
  }

  async function pollUntilDone(id: string) {
    const delay = 2000;
    const max = 120;
    for (let i = 0; i < max; i++) {
      await new Promise((r) => setTimeout(r, delay));
      const v = await getVideo(id);
      await refresh();
      if (v.status === "READY" || v.status === "FAILED") {
        return;
      }
    }
  }

  async function handleDownloadOriginal(v: VideoItem) {
    setCardMenuOpenId(null);
    setDownloadBusyId(v.id);
    try {
      const { url, filename } = await getOriginalDownloadLink(v.id);
      await downloadFromUrl(url, filename);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloadBusyId(null);
    }
  }

  function openEditModal(v: VideoItem) {
    setEditModalVideo(v);
    setEditDraftTitle(v.title);
    setEditModalError(null);
    setCardMenuOpenId(null);
  }

  function closeEditModal() {
    setEditModalVideo(null);
    setEditDraftTitle("");
    setEditModalError(null);
    setEditModalSaving(false);
  }

  async function submitEditTitle(e: React.FormEvent) {
    e.preventDefault();
    if (!editModalVideo) return;
    const t = editDraftTitle.trim();
    if (!t) {
      setEditModalError("El título no puede estar vacío.");
      return;
    }
    setEditModalSaving(true);
    setEditModalError(null);
    try {
      const updated = await updateVideoTitle(editModalVideo.id, myUploaderId, t);
      setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setSelected((cur) => (cur?.id === updated.id ? updated : cur));
      closeEditModal();
    } catch (err) {
      setEditModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditModalSaving(false);
    }
  }

  function openDeleteModal(v: VideoItem) {
    setDeleteModalVideo(v);
    setDeleteModalError(null);
    setCardMenuOpenId(null);
  }

  function closeDeleteModal() {
    setDeleteModalVideo(null);
    setDeleteModalError(null);
    setDeleteModalDeleting(false);
  }

  async function confirmDeleteVideo() {
    if (!deleteModalVideo) return;
    setDeleteModalDeleting(true);
    setDeleteModalError(null);
    try {
      const sess = uploadSessionRef.current;
      if (sess?.videoId === deleteModalVideo.id) {
        sess.abort.abort();
      }
      await deleteVideo(deleteModalVideo.id, myUploaderId);
      if (selected?.id === deleteModalVideo.id) {
        navigate("/", { replace: true });
      }
      await refresh();
      closeDeleteModal();
    } catch (err) {
      setDeleteModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleteModalDeleting(false);
    }
  }

  const openModal = () => {
    setIsModalOpen(true);
    setError(null);
    setUploadPercent(null);
  };
  const closeModal = () => {
    setIsModalOpen(false);
    setTitle("");
    setFile(null);
    setError(null);
    setUploadPercent(null);
  };

  return (
    <>
      <nav className="navbar">
        <div className="navbar-brand" onClick={() => navigate("/")}>
          <img className="navbar-logo" src="/favicon-32.png" alt="" width={28} height={28} />
          IOL Video
        </div>
        <button className="btn-create" onClick={openModal}>
          + Crear
        </button>
      </nav>

      {selected ? (
        <main className="player-container">
          <div className="video-section">
            <div className="video-wrapper">
              {selected.status === "READY" && selected.manifestUrl ? (
                <VideoPlayer
                  manifestUrl={selected.manifestUrl}
                  videoId={selected.id}
                  viewerKey={myUploaderId}
                  durationSeconds={selected.durationSeconds}
                  onViewCountUpdated={(c) => patchViewCount(selected.id, c)}
                />
              ) : selected.status === "FAILED" ? (
                <div style={{aspectRatio: "16/9", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "12px"}}>
                  <span className="err">Error al procesar ({selected.errorMessage})</span>
                </div>
              ) : (
                <div style={{aspectRatio: "16/9", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "12px"}}>
                  <span style={{color: "#aaa"}}>
                    {selected.status === "UPLOADED"
                      ? "En cola"
                      : selected.status === "PROCESSING"
                        ? "Procesando"
                        : selected.status === "CREATED"
                          ? "Subiendo"
                          : selected.status}
                    …
                    {selected.progressPercent != null
                      ? ` ${selected.progressPercent}%`
                      : ""}
                  </span>
                </div>
              )}
            </div>
            <h1 className="player-title">{selected.title}</h1>
            <p className="card-meta player-channel-row">
              <span>IOL Channel</span>
              <span className="verified-badge" title="Canal verificado" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 1L15 8h7l-5.5 4.2L19 22l-7-4.5L5 22l2.5-9.8L2 8h7L12 1z"
                    fill="#3ea6ff"
                  />
                  <path
                    d="M8.5 12.2l2.5 2.4 5-5"
                    stroke="#0f0f0f"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </p>
            <p className="card-meta player-stats-row">
              {formatViewsLine(selected.viewCount ?? 0)} • {formatRelativeUploadDate(selected.createdAt)}
            </p>
          </div>
          <div className="related-section">
            <h3 style={{marginTop: 0}}>Siguientes videos</h3>
            <div className="related-list">
              {items
                .filter((v) => v.status === "READY" && v.id !== selected.id)
                .map((v) => (
                <div
                  key={v.id}
                  className="related-row related-row-ready"
                  onClick={() => navigate(`/watch/${v.id}`)}
                >
                  <div className="related-thumb">
                    {v.thumbnailUrl ? (
                      <>
                        <img
                          src={v.thumbnailUrl}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                            const fb = e.currentTarget.nextElementSibling;
                            if (fb) fb.classList.remove("is-hidden");
                          }}
                        />
                        <span className="thumb-fallback is-hidden" aria-hidden>
                          ▶
                        </span>
                      </>
                    ) : (
                      <span className="thumb-fallback" aria-hidden>
                        ▶
                      </span>
                    )}
                  </div>
                  <div className="related-row-text">
                    <h4
                      style={{
                        margin: "0 0 4px 0",
                        fontSize: "0.9rem",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {v.title}
                    </h4>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <main className="dashboard">
          {items.map((v) => {
            const isMine = v.uploaderId === myUploaderId;
            return (
            <div
              key={v.id}
              className="video-card video-card-ready"
              style={{ position: "relative" }}
              onMouseEnter={() => {
                if (v.manifestUrl) setHoverPreviewId(v.id);
              }}
              onMouseLeave={() => setHoverPreviewId(null)}
            >
              <div
                className="thumbnail"
                onClick={() => {
                  const openMenu = cardMenuOpenId;
                  if (openMenu != null) {
                    setCardMenuOpenId(null);
                    if (openMenu === v.id) return;
                  }
                  navigate(`/watch/${v.id}`);
                }}
              >
                {v.thumbnailUrl ? (
                  <>
                    <img
                      src={v.thumbnailUrl}
                      alt=""
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                        const fb = e.currentTarget.nextElementSibling;
                        if (fb) fb.classList.remove("is-hidden");
                      }}
                    />
                    <span className="thumb-fallback is-hidden" aria-hidden>
                      ▶
                    </span>
                  </>
                ) : (
                  <span className="thumb-fallback" aria-hidden>
                    ▶
                  </span>
                )}
                {v.manifestUrl &&
                hoverPreviewId === v.id &&
                cardMenuOpenId !== v.id ? (
                  <VideoHoverPreview
                    manifestUrl={v.manifestUrl}
                    posterUrl={v.thumbnailUrl}
                    resumeAt={hoverPreviewTimeById.current.get(v.id) ?? 0}
                    onCommitTime={(t) => {
                      hoverPreviewTimeById.current.set(v.id, t);
                    }}
                  />
                ) : null}
                {v.durationSeconds != null &&
                Number.isFinite(v.durationSeconds) &&
                v.durationSeconds > 0 ? (
                  <span className="thumb-duration">{formatVideoDurationHms(v.durationSeconds)}</span>
                ) : null}
              </div>
              <div className="card-info">
                <div className="avatar">I</div>
                <div className="card-text">
                  <div className="card-title-row">
                    <h3
                      className="card-title"
                      onClick={() => {
                        const openMenu = cardMenuOpenId;
                        if (openMenu != null) {
                          setCardMenuOpenId(null);
                          if (openMenu === v.id) return;
                        }
                        navigate(`/watch/${v.id}`);
                      }}
                    >
                      {v.title}
                    </h3>
                    <div className="card-more-wrap">
                        <button
                          type="button"
                          className="card-more-btn"
                          aria-label="Acciones del video"
                          aria-expanded={cardMenuOpenId === v.id}
                          aria-haspopup="menu"
                          onPointerDown={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCardMenuOpenId((cur) => (cur === v.id ? null : v.id));
                          }}
                        >
                          <svg
                            className="card-more-dots"
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="currentColor"
                            aria-hidden
                          >
                            <circle cx="12" cy="6" r="1.75" />
                            <circle cx="12" cy="12" r="1.75" />
                            <circle cx="12" cy="18" r="1.75" />
                          </svg>
                        </button>
                        {cardMenuOpenId === v.id ? (
                          <div
                            className="card-more-menu"
                            role="menu"
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="card-more-menu-item"
                              role="menuitem"
                              disabled={downloadBusyId === v.id}
                              onClick={() => void handleDownloadOriginal(v)}
                            >
                              {downloadBusyId === v.id ? "Descargando…" : "Descargar"}
                            </button>
                            {isMine ? (
                              <>
                                <button
                                  type="button"
                                  className="card-more-menu-item"
                                  role="menuitem"
                                  onClick={() => openEditModal(v)}
                                >
                                  Editar
                                </button>
                                <button
                                  type="button"
                                  className="card-more-menu-item card-more-menu-danger"
                                  role="menuitem"
                                  onClick={() => openDeleteModal(v)}
                                >
                                  Eliminar
                                </button>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                  </div>
                  <p className="card-meta card-channel-row">
                    <span>IOL Channel</span>
                    <span className="verified-badge verified-badge-sm" title="Canal verificado" aria-hidden>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                        <path
                          d="M12 1L15 8h7l-5.5 4.2L19 22l-7-4.5L5 22l2.5-9.8L2 8h7L12 1z"
                          fill="#aaa"
                        />
                        <path
                          d="M8.5 12.2l2.5 2.4 5-5"
                          stroke="#0f0f0f"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </p>
                  <p className="card-meta card-views-row">
                    {`${formatViewsLine(v.viewCount ?? 0)} • ${formatRelativeUploadDate(v.createdAt)}`}
                  </p>
                </div>
              </div>
            </div>
            );
          })}
          {items.length === 0 && (
             <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px", color: "#aaa", fontSize: "1.2rem" }}>
                Aún no hay videos. ¡Sube el primero usando el botón Crear!
             </div>
          )}
        </main>
      )}

      {editModalVideo && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEditModal();
          }}
        >
          <div className="modal-content" role="dialog" aria-labelledby="edit-modal-title">
            <div className="modal-header">
              <span id="edit-modal-title">Editar video</span>
              <button type="button" className="btn-close" onClick={closeEditModal} aria-label="Cerrar">
                &times;
              </button>
            </div>
            <div className="modal-body">
              <form
                onSubmit={(e) => void submitEditTitle(e)}
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                  maxWidth: "480px",
                }}
              >
                <div className="form-group">
                  <label htmlFor={editTitleInputId}>Título del video</label>
                  <input
                    id={editTitleInputId}
                    type="text"
                    value={editDraftTitle}
                    onChange={(e) => setEditDraftTitle(e.target.value)}
                    disabled={editModalSaving}
                    required
                  />
                </div>
                {editModalError ? <p className="err">{editModalError}</p> : null}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="btn-modal-secondary"
                    onClick={closeEditModal}
                    disabled={editModalSaving}
                  >
                    Cancelar
                  </button>
                  <button type="submit" className="btn-primary" disabled={editModalSaving}>
                    {editModalSaving ? "Guardando…" : "Guardar"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {deleteModalVideo && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleteModalDeleting) closeDeleteModal();
          }}
        >
          <div className="modal-content" role="dialog" aria-labelledby="delete-modal-title">
            <div className="modal-header">
              <span id="delete-modal-title">Eliminar video</span>
              <button
                type="button"
                className="btn-close"
                onClick={closeDeleteModal}
                disabled={deleteModalDeleting}
                aria-label="Cerrar"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-confirm-text">
                ¿Eliminar permanentemente{" "}
                <strong>{deleteModalVideo.title}</strong>? Esta acción no se puede deshacer.
              </p>
              {deleteModalVideo.status !== "READY" ? (
                <p className="modal-confirm-text modal-confirm-sub">
                  Si la subida sigue en curso en este navegador, se cancelará antes de borrar.
                </p>
              ) : null}
              {deleteModalError ? <p className="err">{deleteModalError}</p> : null}
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-modal-secondary"
                  onClick={closeDeleteModal}
                  disabled={deleteModalDeleting}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn-modal-danger"
                  onClick={() => void confirmDeleteVideo()}
                  disabled={deleteModalDeleting}
                >
                  {deleteModalDeleting ? "Eliminando…" : "Eliminar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <span>Subir vídeos</span>
              <button className="btn-close" onClick={closeModal}>&times;</button>
            </div>
            
            <div className="modal-body">
               <div className="upload-icon-circle">
                 <img src="/icon-video-48.png" alt="" width={56} height={56} />
               </div>
               <div className="upload-text">
                  <h3 style={{margin: "0 0 8px 0"}}>Arrastra y suelta archivos de video para subirlos</h3>
                  <p>Tus videos se procesarán tras subirlos.</p>
               </div>
               
               <form onSubmit={handleUpload} style={{width: "100%", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "480px", marginTop: "12px"}}>
                 <div className="form-group">
                   <label>Título del video</label>
                   <input
                     type="text"
                     placeholder="Añade un título"
                     value={title}
                     onChange={(e) => setTitle(e.target.value)}
                     disabled={loading}
                     required
                   />
                 </div>

                 <div className="form-group">
                   <span className="form-group-label">Archivo</span>
                   <div className="file-input-wrap">
                     <input
                       id={fileInputId}
                       className="file-input-native"
                       type="file"
                       accept="video/*"
                       onChange={(e) => {
                         const f = e.target.files?.[0] ?? null;
                         setFile(f);
                         if (f && !title) setTitle(f.name.split('.').slice(0, -1).join('.') || f.name);
                       }}
                       disabled={loading}
                       required
                     />
                     <label htmlFor={fileInputId} className="file-input-trigger">
                       Seleccionar archivo
                     </label>
                     <span className="file-input-filename" title={file?.name}>
                       {file ? file.name : "Sin archivos seleccionados"}
                     </span>
                   </div>
                 </div>

                {error && <p className="err">{error}</p>}

                {loading && uploadPercent != null ? (
                  <div style={{ width: "100%", maxWidth: 480 }}>
                    <div
                      style={{
                        height: 8,
                        borderRadius: 4,
                        background: "#333",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${uploadPercent}%`,
                          background: "#3ea6ff",
                          transition: "width 0.15s ease",
                        }}
                      />
                    </div>
                    <p style={{ margin: "8px 0 0", textAlign: "center", color: "#aaa", fontSize: "0.9rem" }}>
                      Subiendo… {uploadPercent}%
                    </p>
                  </div>
                ) : null}

                <div style={{display: "flex", justifyContent: "center", marginTop: "16px"}}>
                  <button type="submit" disabled={loading || !file} className="btn-primary" style={{padding: "12px 32px", fontSize: "1rem"}}>
                    {loading ? "Subiendo..." : "Seleccionar y Subir"}
                  </button>
                </div>
               </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
