import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  completeVideo,
  createVideo,
  getVideo,
  listVideos,
  uploadToPresigned,
  deleteVideo,
  type VideoItem,
} from "./api";
import { VideoPlayer } from "./VideoPlayer";
import { VideoHoverPreview } from "./VideoHoverPreview";
import { formatFullUploadDateDetail, formatRelativeUploadDate } from "./formatUploadDate";
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
  const hoverPreviewTimeById = useRef<Map<string, number>>(new Map());
  const fileInputId = useId();

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
      const created = await createVideo({
        title: title.trim() || "Sin título",
        originalFilename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        uploaderId: myUploaderId,
      });
      await uploadToPresigned(created.uploadUrl, file, created.method, (p) =>
        setUploadPercent(p),
      );
      await completeVideo(created.id);
      await refresh();
      
      setIsModalOpen(false); // Close on success
      setTitle("");
      setFile(null);
      
      pollUntilDone(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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

  async function handleDelete(id: string) {
    if (!confirm("¿Seguro que quieres eliminar este video?")) return;
    try {
      await deleteVideo(id, myUploaderId);
      if (selected?.id === id) {
        setSelected(null);
      }
      await refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
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
        <div className="navbar-brand" onClick={() => setSelected(null)}>
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
                <VideoPlayer manifestUrl={selected.manifestUrl} />
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
            <p className="card-meta">
              IOL Channel • {formatFullUploadDateDetail(selected.createdAt)}
            </p>
          </div>
          <div className="related-section">
            <h3 style={{marginTop: 0}}>Siguientes videos</h3>
            <div className="related-list">
              {items.filter((v) => v.id !== selected.id).map((v) => (
                <div
                  key={v.id}
                  className={`related-row ${v.status === "READY" ? "related-row-ready" : "related-row-pending"}`}
                  onClick={() => {
                    setSelected(v);
                  }}
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
                    <span className={`pill pill-${v.status}`}>
                      {v.status}
                      {v.progressPercent != null ? ` ${v.progressPercent}%` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <main className="dashboard">
          {items.map((v) => {
            const openable = v.status === "READY";
            return (
            <div
              key={v.id}
              className={`video-card ${openable ? "video-card-ready" : "video-card-pending"}`}
              style={{ position: "relative" }}
              onMouseEnter={() => {
                if (openable && v.manifestUrl) setHoverPreviewId(v.id);
              }}
              onMouseLeave={() => setHoverPreviewId(null)}
            >
              <div
                className="thumbnail"
                onClick={() => {
                  setSelected(v);
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
                {openable && v.manifestUrl && hoverPreviewId === v.id ? (
                  <VideoHoverPreview
                    manifestUrl={v.manifestUrl}
                    resumeAt={hoverPreviewTimeById.current.get(v.id) ?? 0}
                    onCommitTime={(t) => {
                      hoverPreviewTimeById.current.set(v.id, t);
                    }}
                  />
                ) : null}
              </div>
              <div className="card-info">
                <div className="avatar">I</div>
                <div className="card-text">
                  <h3
                    className="card-title"
                    onClick={() => {
                      setSelected(v);
                    }}
                  >
                    {v.title}
                  </h3>
                  <p className="card-meta">IOL Channel</p>
                  <p className="card-meta">{formatRelativeUploadDate(v.createdAt)}</p>
                  <div>
                    <span className={`pill pill-${v.status}`}>
                      {v.status}
                      {v.progressPercent != null ? ` ${v.progressPercent}%` : ""}
                    </span>
                  </div>
                </div>
              </div>
              {v.uploaderId === myUploaderId && (
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDelete(v.id); }}
                  style={{position: "absolute", top: "8px", right: "8px", background: "rgba(0,0,0,0.7)", border: "none", color: "#ff4e45", borderRadius: "50%", width: "32px", height: "32px", cursor: "pointer", zIndex: 10, display: "flex", justifyContent: "center", alignItems: "center"}}
                  title="Eliminar mi video"
                >
                  <span style={{fontSize: "1.2rem"}}>🗑</span>
                </button>
              )}
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
