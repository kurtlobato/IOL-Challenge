import { useCallback, useEffect, useState } from "react";
import {
  completeVideo,
  createVideo,
  getVideo,
  listVideos,
  uploadToPresigned,
  type VideoItem,
} from "./api";
import { VideoPlayer } from "./VideoPlayer";
import "./App.css";

export default function App() {
  const [items, setItems] = useState<VideoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("Mi video");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<VideoItem | null>(null);

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
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      const created = await createVideo({
        title: title.trim() || "Sin título",
        originalFilename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      });
      await uploadToPresigned(created.uploadUrl, file, created.method);
      await completeVideo(created.id);
      await refresh();
      const v = await getVideo(created.id);
      setSelected(v);
      pollUntilDone(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function pollUntilDone(id: string) {
    const delay = 2000;
    const max = 120;
    for (let i = 0; i < max; i++) {
      await new Promise((r) => setTimeout(r, delay));
      const v = await getVideo(id);
      setSelected(v);
      if (v.status === "READY" || v.status === "FAILED") {
        await refresh();
        return;
      }
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>IOL Video</h1>
        <p className="sub">Subida directa a almacenamiento (pre-signed) y reproducción HLS</p>
      </header>

      <section className="panel">
        <h2>Subir video</h2>
        <form onSubmit={handleUpload} className="form">
          <label>
            Título
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={loading}
            />
          </label>
          <label>
            Archivo (máx. 1 GB según API)
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={loading}
            />
          </label>
          <button type="submit" disabled={loading || !file}>
            {loading ? "Subiendo…" : "Subir"}
          </button>
        </form>
        {error && <p className="err">{error}</p>}
      </section>

      <section className="panel">
        <h2>Videos</h2>
        <ul className="list">
          {items.map((v) => (
            <li key={v.id}>
              <button type="button" className="linkish" onClick={() => setSelected(v)}>
                {v.title}
              </button>
              <span className={`pill pill-${v.status}`}>{v.status}</span>
              <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section className="panel">
          <h2>Detalle</h2>
          <p>
            <strong>{selected.title}</strong> — {selected.status}
          </p>
          {selected.errorMessage && <p className="err">{selected.errorMessage}</p>}
          {selected.status === "READY" && selected.manifestUrl && (
            <VideoPlayer manifestUrl={selected.manifestUrl} />
          )}
          {(selected.status === "UPLOADED" || selected.status === "PROCESSING") && (
            <p className="muted">Procesando… actualizá la lista o esperá.</p>
          )}
        </section>
      )}
    </div>
  );
}
