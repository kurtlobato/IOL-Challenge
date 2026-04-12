const API = "/api";

export type VideoItem = {
  id: string;
  title: string;
  status: string;
  manifestUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  uploaderId: string | null;
  createdAt: string;
  /** 0–100 en cola/proceso; null en CREATED/READY/FAILED */
  progressPercent: number | null;
  durationSeconds: number | null;
  viewCount: number;
};

export type CreateVideoBody = {
  title: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  uploaderId: string;
};

export type CreateVideoResult = {
  id: string;
  uploadUrl: string;
  method: string;
  objectKey: string;
  expiresInSeconds: number;
};

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function createVideo(body: CreateVideoBody): Promise<CreateVideoResult> {
  const res = await fetch(`${API}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<CreateVideoResult>(res);
}

export async function completeVideo(id: string): Promise<void> {
  const res = await fetch(`${API}/videos/${id}/complete`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
}

export async function getVideo(id: string): Promise<VideoItem> {
  const res = await fetch(`${API}/videos/${id}`);
  return parseJson<VideoItem>(res);
}

export async function listVideos(): Promise<VideoItem[]> {
  const res = await fetch(`${API}/videos`);
  return parseJson<VideoItem[]>(res);
}

export async function recordView(
  id: string,
  viewerKey: string,
  watchedSeconds: number,
): Promise<number> {
  const res = await fetch(`${API}/videos/${id}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewerKey, watchedSeconds }),
  });
  const data = await parseJson<{ viewCount: number }>(res);
  return data.viewCount;
}

export function uploadToPresigned(
  uploadUrl: string,
  file: File,
  method: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method || "PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((100 * ev.loaded) / ev.total));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Error de red al subir"));
    xhr.send(file);
  });
}

export async function deleteVideo(id: string, uploaderId: string): Promise<void> {
  const res = await fetch(`${API}/videos/${id}?uploaderId=${encodeURIComponent(uploaderId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
}

export async function updateVideoTitle(
  id: string,
  uploaderId: string,
  title: string,
): Promise<VideoItem> {
  const res = await fetch(`${API}/videos/${id}?uploaderId=${encodeURIComponent(uploaderId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return parseJson<VideoItem>(res);
}

export async function getOriginalDownloadLink(
  id: string,
  uploaderId?: string | null,
): Promise<{ url: string; filename: string }> {
  const q =
    uploaderId != null && uploaderId !== ""
      ? `?uploaderId=${encodeURIComponent(uploaderId)}`
      : "";
  const res = await fetch(`${API}/videos/${id}/original-download${q}`);
  return parseJson<{ url: string; filename: string }>(res);
}
