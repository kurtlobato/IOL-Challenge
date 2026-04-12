import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatVideoDurationHms } from "./formatYoutubeStats";

type Props = {
  manifestUrl: string;
  resumeAt?: number;
  onCommitTime?: (seconds: number) => void;
};

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

export function VideoHoverPreview({ manifestUrl, resumeAt = 0, onCommitTime }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const onCommitRef = useRef(onCommitTime);
  onCommitRef.current = onCommitTime;

  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; label: string } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const readDuration = (v: HTMLVideoElement) =>
    Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  const readCurrent = (v: HTMLVideoElement) =>
    Number.isFinite(v.currentTime) && v.currentTime >= 0 ? v.currentTime : 0;

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.loop = true;

    const tryPlay = () => {
      applyResumeTime(video, resumeAt);
      void video.play().catch(() => {});
    };

    const commit = () => {
      const t = video.currentTime;
      if (Number.isFinite(t) && t >= 0) onCommitRef.current?.(t);
    };

    const sync = () => {
      setProgress({ current: readCurrent(video), duration: readDuration(video) });
    };
    video.addEventListener("timeupdate", sync);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    video.addEventListener("seeked", sync);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay, { once: true });
      return () => {
        commit();
        video.removeEventListener("canplay", tryPlay);
        video.removeEventListener("timeupdate", sync);
        video.removeEventListener("loadedmetadata", sync);
        video.removeEventListener("durationchange", sync);
        video.removeEventListener("seeked", sync);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay, { once: true });
      return () => {
        commit();
        video.removeEventListener("canplay", tryPlay);
        video.removeEventListener("timeupdate", sync);
        video.removeEventListener("loadedmetadata", sync);
        video.removeEventListener("durationchange", sync);
        video.removeEventListener("seeked", sync);
        video.removeAttribute("src");
        video.load();
      };
    }

    const hls = new Hls({ enableWorker: true });
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    video.addEventListener("canplay", tryPlay, { once: true });
    return () => {
      commit();
      video.removeEventListener("canplay", tryPlay);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
      video.removeEventListener("seeked", sync);
      hls.destroy();
      video.removeAttribute("src");
      video.load();
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
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [scrubbing, seekTo, timeFromClientX]);

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
          }}
          onMouseMove={(e) => {
            if (scrubbing) return;
            const t = timeFromClientX(e.clientX);
            if (t == null) {
              setTooltip(null);
              return;
            }
            const rail = railRef.current;
            if (!rail) return;
            const rect = rail.getBoundingClientRect();
            setTooltip({
              x: clamp(e.clientX - rect.left, 0, rect.width),
              label: formatVideoDurationHms(t),
            });
          }}
          onMouseLeave={() => {
            if (!scrubbing) setTooltip(null);
          }}
        >
          <div className="thumb-preview-rail-track" />
          <div className="thumb-preview-rail-played" style={{ width: `${playedPct}%` }} />
          {duration > 0 ? (
            <div className="thumb-preview-rail-handle" style={{ left: `${playedPct}%` }} />
          ) : null}
          {tooltip && !scrubbing ? (
            <div className="thumb-preview-tooltip" style={{ left: tooltip.x }}>
              {tooltip.label}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
