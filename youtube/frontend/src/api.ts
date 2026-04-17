const STORAGE_KEY = "lanflix_api_base";

function envBase(): string {
  const v = import.meta.env.VITE_API_BASE;
  return typeof v === "string" ? v : "";
}

/** Base URL del nodo semilla (sin barra final), o vacío para mismo origen (`/api`). */
export function getApiBase(): string {
  if (typeof localStorage === "undefined") {
    return envBase().replace(/\/$/, "");
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  const base = (saved ?? envBase() ?? "").trim();
  return base.replace(/\/$/, "");
}

export function setApiBase(url: string): void {
  const t = url.trim().replace(/\/$/, "");
  if (!t) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, t);
}

function apiPrefix(): string {
  const b = getApiBase();
  if (!b) return "/api";
  return `${b}/api`;
}

export type VideoItem = {
  id: string;
  nodeId: string;
  nodeName?: string;
  title: string;
  status: string;
  streamUrl: string;
  manifestUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  uploaderId: string | null;
  createdAt: string;
  progressPercent: number | null;
  durationSeconds: number | null;
  viewCount: number;
  source?: {
    container: string;
    videoCodec: string;
    audioCodec: string;
    pixFmt: string;
  } | null;
  compat?: {
    browserPlayable: boolean;
    reason?: string;
  } | null;
  transcode?: {
    status: string;
    error?: string;
    mp4Url?: string | null;
    progressPercent?: number | null;
    queuePosition?: number | null;
    outTimeMs?: number | null;
  } | null;
};

export type TranscodeStatus = {
  nodeId: string;
  running: {
    videoId: string;
    progressPercent?: number;
    outTimeMs?: number;
  } | null;
  queued: string[];
};

export async function getTranscodeStatus(
  apiOrigin?: string | null,
): Promise<TranscodeStatus> {
  const prefix =
    apiOrigin != null && apiOrigin !== ""
      ? `${apiOrigin.replace(/\/$/, "")}/api`
      : apiPrefix();
  const res = await fetch(`${prefix}/transcode/status`);
  return parseJson<TranscodeStatus>(res);
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type ListVideosOptions = {
  federated?: boolean;
};

export async function listVideos(opts?: ListVideosOptions): Promise<VideoItem[]> {
  const q =
    opts?.federated === true ? "?federated=true" : "";
  const res = await fetch(`${apiPrefix()}/videos${q}`);
  const raw = await parseJson<VideoItem[]>(res);
  return raw.map(normalizeVideo);
}

export async function getVideo(id: string): Promise<VideoItem> {
  const enc = encodeURIComponent(id);
  const res = await fetch(`${apiPrefix()}/videos/${enc}`);
  return normalizeVideo(await parseJson<VideoItem>(res));
}

export async function requestTranscodeMp4(
  id: string,
  apiOrigin?: string | null,
): Promise<{ status: string }> {
  const enc = encodeURIComponent(id);
  const prefix =
    apiOrigin != null && apiOrigin !== ""
      ? `${apiOrigin.replace(/\/$/, "")}/api`
      : apiPrefix();
  const res = await fetch(`${prefix}/videos/${enc}/transcode`, { method: "POST" });
  if (res.status === 202) {
    return parseJson<{ status: string }>(res);
  }
  return parseJson<{ status: string }>(res);
}

export async function recordView(
  id: string,
  viewerKey: string,
  watchedSeconds: number,
  apiOrigin?: string | null,
): Promise<number> {
  const enc = encodeURIComponent(id);
  const prefix =
    apiOrigin != null && apiOrigin !== ""
      ? `${apiOrigin.replace(/\/$/, "")}/api`
      : apiPrefix();
  const res = await fetch(`${prefix}/videos/${enc}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewerKey, watchedSeconds }),
  });
  const data = await parseJson<{ viewCount: number }>(res);
  return data.viewCount;
}

export type NodeInfo = {
  nodeId: string;
  baseUrl: string;
  name: string;
  version: string;
};

export async function listNodes(depth = 4): Promise<NodeInfo[]> {
  const res = await fetch(`${apiPrefix()}/nodes?depth=${depth}`);
  return parseJson<NodeInfo[]>(res);
}

function normalizeVideo(v: VideoItem): VideoItem {
  return {
    ...v,
    viewCount: typeof v.viewCount === "number" ? v.viewCount : 0,
    manifestUrl: v.manifestUrl ?? null,
    streamUrl: v.streamUrl ?? "",
    source: v.source ?? null,
    compat: v.compat ?? null,
    transcode: v.transcode ?? null,
  };
}

export function playbackOrigin(streamUrl: string): string {
  try {
    return new URL(streamUrl).origin;
  } catch {
    return "";
  }
}
