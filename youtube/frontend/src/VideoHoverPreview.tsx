import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { setThumbnailAtSeconds } from "./api";
import { formatVideoDurationHms } from "./formatYoutubeStats";

type MediaSource = { kind: "hls"; url: string } | { kind: "progressive"; url: string };

function resolveMediaSource(
  manifestUrl: string | null | undefined,
  progressiveUrl: string | null | undefined,
): MediaSource | null {
  const m = manifestUrl?.trim();
  if (m) return { kind: "hls", url: m };
  const p = progressiveUrl?.trim();
  if (p) return { kind: "progressive", url: p };
  return null;
}

type Props = {
  manifestUrl?: string | null;
  progressiveUrl?: string | null;
  resumeAt?: number;
  onCommitTime?: (seconds: number) => void;
  posterUrl?: string | null;
  interactionLocked?: boolean;
  videoId?: string;
  thumbnailApiOrigin?: string | null;
  onThumbnailUpdated?: () => void | Promise<void>;
  onThumbnailError?: (message: string) => void;
};

const PROBE_SEEK_MS = 100;
const COMMIT_INTERVAL_MS = 750;

function applyResumeTime(video: HTMLVideoElement, resumeAt: number) {
  if (resumeAt <= 0 || !Number.isFinite(resumeAt)) return;
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) {
    video.currentTime = Math.min(resumeAt, Math.max(0, d - 0.05));
  } else {
    video.currentTime = resumeAt;
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function readDuration(v: HTMLVideoElement) {
  return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
}

function readCurrent(v: HTMLVideoElement) {
  return Number.isFinite(v.currentTime) && v.currentTime >= 0 ? v.currentTime : 0;
}

function attachProgressive(
  video: HTMLVideoElement,
  url: string,
  options: { playOnReady: boolean; resumeAt: number },
): () => void {
  video.muted = true;
  video.loop = options.playOnReady;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  const onReady = () => {
    if (options.playOnReady) {
      applyResumeTime(video, options.resumeAt);
      void video.play().catch(() => {});
    } else {
      video.pause();
      video.currentTime = 0;
    }
  };
  video.addEventListener("canplay", onReady, { once: true });
  return () => {
    video.removeEventListener("canplay", onReady);
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
}

/** Conecta manifest HLS o URL progresiva; devuelve cleanup. */
function attachMedia(
  video: HTMLVideoElement,
  source: MediaSource,
  options: { playOnReady: boolean; resumeAt: number },
): () => void {
  if (source.kind === "progressive") {
    return attachProgressive(video, source.url, options);
  }

  const manifestUrl = source.url;
  video.muted = true;
  video.loop = options.playOnReady;
  video.playsInline = true;

  const onReady = () => {
    if (options.playOnReady) {
      applyResumeTime(video, options.resumeAt);
      void video.play().catch(() => {});
    } else {
      video.pause();
      video.currentTime = 0;
    }
  };

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = manifestUrl;
    video.addEventListener("canplay", onReady, { once: true });
    return () => {
      video.removeEventListener("canplay", onReady);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }

  if (!Hls.isSupported()) {
    video.src = manifestUrl;
    video.addEventListener("canplay", onReady, { once: true });
    return () => {
      video.removeEventListener("canplay", onReady);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }

  const hlsConfig: { enableWorker: boolean; startPosition?: number } = { enableWorker: true };
  if (options.playOnReady && options.resumeAt > 0) {
    hlsConfig.startPosition = options.resumeAt;
  }
  const hls = new Hls(hlsConfig);
  hls.loadSource(manifestUrl);
  hls.attachMedia(video);
  video.addEventListener("canplay", onReady, { once: true });
  return () => {
    video.removeEventListener("canplay", onReady);
    hls.destroy();
    video.pause();
    video.removeAttribute("src");
    video.load();
  };
}

export function VideoHoverPreview({
  manifestUrl,
  progressiveUrl,
  resumeAt = 0,
  onCommitTime,
  posterUrl,
  interactionLocked = false,
  videoId,
  thumbnailApiOrigin,
  onThumbnailUpdated,
  onThumbnailError,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tipVideoRef = useRef<HTMLVideoElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onCommitRef = useRef(onCommitTime);
  onCommitRef.current = onCommitTime;

  const previewThrottleRef = useRef<{
    pending: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ pending: null, timer: null });
  const pendingTipSeekRef = useRef<number | null>(null);

  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; label: string } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [tipPreviewBusy, setTipPreviewBusy] = useState(true);
  const [thumbMenu, setThumbMenu] = useState<{ x: number; y: number; seconds: number } | null>(
    null,
  );
  const [thumbBusy, setThumbBusy] = useState(false);

  const media = resolveMediaSource(manifestUrl, progressiveUrl);
  const mediaKey = media ? `${media.kind}:${media.url}` : "";

  const timeFromClientX = useCallback((clientX: number) => {
    const rail = railRef.current;
    const video = videoRef.current;
    if (!rail || !video) return null;
    const d = readDuration(video);
    if (d <= 0) return null;
    const rect = rail.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    return ratio * d;
  }, []);

  const pointerInRail = useCallback((clientX: number, clientY: number) => {
    const rail = railRef.current;
    if (!rail) return false;
    const r = rail.getBoundingClientRect();
    return (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    );
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const d = readDuration(video);
    if (d <= 0) return;
    const t = clamp(seconds, 0, d - 1e-3);
    video.currentTime = t;
    onCommitRef.current?.(t);
    setProgress({ current: t, duration: d });
  }, []);

  const clearTipThrottle = useCallback(() => {
    const s = previewThrottleRef.current;
    if (s.timer != null) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    s.pending = null;
  }, []);

  const flushSeekTipVideo = useCallback((t: number) => {
    const tip = tipVideoRef.current;
    if (!tip) return;
    const dTip = readDuration(tip);
    const dMain = videoRef.current ? readDuration(videoRef.current) : 0;
    const d = dTip > 0 ? dTip : dMain;
    if (d <= 0) return;
    const tt = clamp(t, 0, d - 1e-3);
    if (Math.abs(tip.currentTime - tt) < 0.04) return;
    tip.currentTime = tt;
  }, []);

  const queueTipSeek = useCallback(
    (t: number) => {
      pendingTipSeekRef.current = t;
      const s = previewThrottleRef.current;
      s.pending = t;
      if (s.timer != null) return;
      s.timer = setTimeout(() => {
        s.timer = null;
        const pending = s.pending;
        s.pending = null;
        if (pending == null) return;
        flushSeekTipVideo(pending);
      }, PROBE_SEEK_MS);
    },
    [flushSeekTipVideo],
  );

  useEffect(() => {
    const main = videoRef.current;
    if (!main || !media) return;

    const cleanMain = attachMedia(main, media, {
      playOnReady: true,
      resumeAt,
    });

    return () => {
      clearTipThrottle();
      cleanMain();
    };
  }, [mediaKey, media, resumeAt, clearTipThrottle]);

  useEffect(() => {
    if (!tooltip || scrubbing || !media) {
      pendingTipSeekRef.current = null;
      return;
    }
    const tip = tipVideoRef.current;
    if (!tip) return;

    setTipPreviewBusy(true);

    const tryClearBusy = () => {
      requestAnimationFrame(() => {
        const el = tipVideoRef.current;
        if (el && !el.seeking) setTipPreviewBusy(false);
      });
    };

    const flushPending = () => {
      const p = pendingTipSeekRef.current;
      if (p != null) flushSeekTipVideo(p);
    };

    const onLoadedData = () => {
      flushPending();
      tryClearBusy();
    };
    const onCanPlay = () => {
      flushPending();
      tryClearBusy();
    };
    const onSeeking = () => setTipPreviewBusy(true);
    const onSeeked = () => tryClearBusy();

    tip.addEventListener("loadeddata", onLoadedData);
    tip.addEventListener("canplay", onCanPlay);
    tip.addEventListener("seeking", onSeeking);
    tip.addEventListener("seeked", onSeeked);

    const cleanTip = attachMedia(tip, media, {
      playOnReady: false,
      resumeAt: 0,
    });

    return () => {
      tip.removeEventListener("loadeddata", onLoadedData);
      tip.removeEventListener("canplay", onCanPlay);
      tip.removeEventListener("seeking", onSeeking);
      tip.removeEventListener("seeked", onSeeked);
      cleanTip();
    };
  }, [tooltip, scrubbing, media, mediaKey, flushSeekTipVideo]);

  useEffect(() => {
    const main = videoRef.current;
    if (!main) return;

    let lastKnownTime = resumeAt;
    let lastPeriodicCommit = 0;
    const sync = () => {
      const cur = readCurrent(main);
      if (cur > 0) {
        lastKnownTime = cur;
      }
      const dur = readDuration(main);
      setProgress({ current: cur, duration: dur });
      const now = performance.now();
      if (now - lastPeriodicCommit >= COMMIT_INTERVAL_MS && cur > 0.2) {
        lastPeriodicCommit = now;
        onCommitRef.current?.(cur);
      }
    };
    main.addEventListener("timeupdate", sync);
    main.addEventListener("loadedmetadata", sync);
    main.addEventListener("durationchange", sync);
    main.addEventListener("seeked", sync);
    return () => {
      if (lastKnownTime >= 0) {
        onCommitRef.current?.(lastKnownTime);
      }
      main.removeEventListener("timeupdate", sync);
      main.removeEventListener("loadedmetadata", sync);
      main.removeEventListener("durationchange", sync);
      main.removeEventListener("seeked", sync);
    };
  }, [mediaKey, resumeAt]);

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => {
      if (!pointerInRail(e.clientX, e.clientY)) return;
      const t = timeFromClientX(e.clientX);
      if (t != null) seekTo(t);
    };
    const onUp = () => {
      setScrubbing(false);
      setTooltip(null);
      clearTipThrottle();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [scrubbing, seekTo, timeFromClientX, pointerInRail, clearTipThrottle]);

  useEffect(() => {
    const main = videoRef.current;
    if (!main) return;
    if (interactionLocked) {
      main.pause();
      const t = readCurrent(main);
      if (Number.isFinite(t) && t >= 0) onCommitRef.current?.(t);
      setTooltip(null);
      clearTipThrottle();
      setScrubbing(false);
    } else {
      void main.play().catch(() => {});
    }
  }, [interactionLocked, clearTipThrottle]);

  useEffect(() => {
    if (!thumbMenu) return;
    let remove: (() => void) | undefined;
    const tid = window.setTimeout(() => {
      const close = (e: MouseEvent) => {
        if (menuRef.current?.contains(e.target as Node)) return;
        setThumbMenu(null);
      };
      window.addEventListener("mousedown", close);
      remove = () => window.removeEventListener("mousedown", close);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      remove?.();
    };
  }, [thumbMenu]);

  useEffect(() => {
    if (!thumbMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThumbMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thumbMenu]);

  const onSetThumbnail = useCallback(async () => {
    if (!videoId || thumbMenu == null) return;
    setThumbBusy(true);
    try {
      await setThumbnailAtSeconds(videoId, thumbMenu.seconds, thumbnailApiOrigin ?? undefined);
      setThumbMenu(null);
      await onThumbnailUpdated?.();
    } catch (e) {
      onThumbnailError?.(e instanceof Error ? e.message : String(e));
    } finally {
      setThumbBusy(false);
    }
  }, [videoId, thumbMenu, thumbnailApiOrigin, onThumbnailUpdated, onThumbnailError]);

  const { current, duration } = progress;
  const playedPct = duration > 0 ? (current / duration) * 100 : 0;

  if (!media) {
    return null;
  }

  return (
    <div
      className={
        "thumbnail-preview-wrap" +
        (interactionLocked ? " thumbnail-preview-wrap--locked" : "")
      }
      aria-hidden={interactionLocked || undefined}
    >
      <video
        ref={videoRef}
        className="thumbnail-preview-video"
        muted
        playsInline
        loop
        aria-hidden
      />
      <div
        className="thumb-preview-progress"
        aria-hidden
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          ref={railRef}
          className="thumb-preview-rail"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const t = timeFromClientX(e.clientX);
            if (t != null) seekTo(t);
            setScrubbing(true);
            setTooltip(null);
            clearTipThrottle();
          }}
          onMouseMove={(e) => {
            if (scrubbing) return;
            const t = timeFromClientX(e.clientX);
            if (t == null) {
              setTooltip(null);
              clearTipThrottle();
              return;
            }
            const rail = railRef.current;
            if (!rail) return;
            const rect = rail.getBoundingClientRect();
            setTooltip({
              x: clamp(e.clientX - rect.left, 0, rect.width),
              label: formatVideoDurationHms(t),
            });
            queueTipSeek(t);
          }}
          onMouseLeave={() => {
            if (!scrubbing) {
              setTooltip(null);
              clearTipThrottle();
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!videoId) return;
            const t = timeFromClientX(e.clientX);
            if (t == null) return;
            setThumbMenu({ x: e.clientX, y: e.clientY, seconds: t });
            setTooltip(null);
          }}
        >
          <div className="thumb-preview-rail-track" />
          <div className="thumb-preview-rail-played" style={{ width: `${playedPct}%` }} />
          {duration > 0 ? (
            <div className="thumb-preview-rail-handle" style={{ left: `${playedPct}%` }} />
          ) : null}
          {tooltip && !scrubbing ? (
            <div className="thumb-preview-tooltip-stack" style={{ left: tooltip.x }}>
              <div
                className="thumb-preview-frame-wrap"
                aria-busy={tipPreviewBusy}
                aria-label={tipPreviewBusy ? "Cargando vista previa" : undefined}
              >
                {tipPreviewBusy ? (
                  <div className="thumb-preview-loader">
                    <div className="thumb-preview-spinner" aria-hidden />
                  </div>
                ) : null}
                {!tipPreviewBusy && posterUrl ? (
                  <img className="thumb-preview-poster" src={posterUrl} alt="" draggable={false} />
                ) : null}
                <video
                  ref={tipVideoRef}
                  className={
                    "thumb-preview-frame-video" +
                    (tipPreviewBusy ? " thumb-preview-frame-video--hidden" : "")
                  }
                  muted
                  playsInline
                  preload="auto"
                  aria-hidden
                />
              </div>
              <div className="thumb-preview-tooltip-label">{tooltip.label}</div>
            </div>
          ) : null}
        </div>
      </div>
      {thumbMenu && videoId ? (
        <div
          ref={menuRef}
          className="thumb-preview-context-menu"
          style={{ left: thumbMenu.x, top: thumbMenu.y }}
          role="menu"
        >
          <button
            type="button"
            className="thumb-preview-context-menu-item"
            role="menuitem"
            disabled={thumbBusy}
            onClick={(e) => {
              e.stopPropagation();
              void onSetThumbnail();
            }}
          >
            {thumbBusy ? "Guardando…" : "Establecer miniatura"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
