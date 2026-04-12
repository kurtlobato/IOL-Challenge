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

export async function uploadToPresigned(
  uploadUrl: string,
  file: File,
  method: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: method || "PUT",
    body: file,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
  });
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }
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
