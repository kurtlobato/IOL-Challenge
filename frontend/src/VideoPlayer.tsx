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

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl;
      return;
    }

    if (!Hls.isSupported()) {
      video.src = manifestUrl;
      return;
    }

    const hls = new Hls({ enableWorker: true });
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    return () => {
      hls.destroy();
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
