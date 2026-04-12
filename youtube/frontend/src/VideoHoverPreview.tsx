import Hls from "hls.js";
import { useEffect, useRef } from "react";

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

export function VideoHoverPreview({ manifestUrl, resumeAt = 0, onCommitTime }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const onCommitRef = useRef(onCommitTime);
  onCommitRef.current = onCommitTime;

  useEffect(() => {
    const video = ref.current;
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

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay, { once: true });
      return () => {
        commit();
        video.removeEventListener("canplay", tryPlay);
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
      hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [manifestUrl, resumeAt]);

  return (
    <video
      ref={ref}
      className="thumbnail-preview-video"
      muted
      playsInline
      loop
      aria-hidden
    />
  );
}
