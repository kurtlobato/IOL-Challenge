import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatVideoDurationHms } from "./formatYoutubeStats";

type Props = {
  manifestUrl: string;
  resumeAt?: number;
  onCommitTime?: (seconds: number) => void;
  /** Mientras carga el preview por scrub; evita recuadro negro vacío. */
  posterUrl?: string | null;
};

const PROBE_SEEK_MS = 100;

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

/** Conecta manifest a un video; devuelve cleanup. */
function attachManifest(
  video: HTMLVideoElement,
  manifestUrl: string,
  options: { playOnReady: boolean; resumeAt: number },
): () => void {
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
      video.removeAttribute("src");
      video.load();
    };
  }

  if (!Hls.isSupported()) {
    video.src = manifestUrl;
    video.addEventListener("canplay", onReady, { once: true });
    return () => {
      video.removeEventListener("canplay", onReady);
      video.removeAttribute("src");
      video.load();
    };
  }

  const hls = new Hls({ enableWorker: true });
  hls.loadSource(manifestUrl);
  hls.attachMedia(video);
  video.addEventListener("canplay", onReady, { once: true });
  return () => {
    video.removeEventListener("canplay", onReady);
    hls.destroy();
    video.removeAttribute("src");
    video.load();
  };
}

export function VideoHoverPreview({
  manifestUrl,
  resumeAt = 0,
  onCommitTime,
  posterUrl,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tipVideoRef = useRef<HTMLVideoElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const onCommitRef = useRef(onCommitTime);
  onCommitRef.current = onCommitTime;

  const previewThrottleRef = useRef<{
    pending: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ pending: null, timer: null });
  /** Último tiempo de scrub (para aplicar cuando el HLS del tooltip termina de cargar). */
  const pendingTipSeekRef = useRef<number | null>(null);

  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; label: string } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  /** Carga HLS / seek del preview en tooltip: oculta poster y muestra spinner. */
  const [tipPreviewBusy, setTipPreviewBusy] = useState(true);

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
    if (!main) return;

    const cleanMain = attachManifest(main, manifestUrl, {
      playOnReady: true,
      resumeAt,
    });

    return () => {
      clearTipThrottle();
      cleanMain();
    };
  }, [manifestUrl, resumeAt, clearTipThrottle]);

  /** HLS solo en el vídeo del tooltip (visible): el decodificador pinta frames reales, sin canvas. */
  useEffect(() => {
    if (!tooltip || scrubbing) {
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

    const cleanTip = attachManifest(tip, manifestUrl, {
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
  }, [tooltip, scrubbing, manifestUrl, flushSeekTipVideo]);

  useEffect(() => {
    const main = videoRef.current;
    if (!main) return;

    const commit = () => {
      const t = main.currentTime;
      if (Number.isFinite(t) && t >= 0) onCommitRef.current?.(t);
    };

    const sync = () => {
      setProgress({ current: readCurrent(main), duration: readDuration(main) });
    };
    main.addEventListener("timeupdate", sync);
    main.addEventListener("loadedmetadata", sync);
    main.addEventListener("durationchange", sync);
    main.addEventListener("seeked", sync);
    return () => {
      commit();
      main.removeEventListener("timeupdate", sync);
      main.removeEventListener("loadedmetadata", sync);
      main.removeEventListener("durationchange", sync);
      main.removeEventListener("seeked", sync);
    };
  }, [manifestUrl, resumeAt]);

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => {
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
  }, [scrubbing, seekTo, timeFromClientX, clearTipThrottle]);

  const { current, duration } = progress;
  const playedPct = duration > 0 ? (current / duration) * 100 : 0;

  return (
    <div className="thumbnail-preview-wrap">
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
    </div>
  );
}
