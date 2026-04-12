import Hls from "hls.js";
import { useEffect, useRef } from "react";

type Props = {
  manifestUrl: string;
};

export function VideoPlayer({ manifestUrl }: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const tryPlay = () => {
      void video.play().catch(() => {});
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay);
      return () => {
        video.removeEventListener("canplay", tryPlay);
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay);
      return () => {
        video.removeEventListener("canplay", tryPlay);
        video.removeAttribute("src");
        video.load();
      };
    }

    const hls = new Hls({ enableWorker: true });
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
    return () => {
      hls.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [manifestUrl]);

  return (
    <video
      ref={ref}
      controls
      playsInline
      style={{ width: "100%", maxWidth: 960, background: "#111" }}
    />
  );
}
