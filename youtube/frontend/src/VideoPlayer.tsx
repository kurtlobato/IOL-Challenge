import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  manifestUrl: string;
};

type LevelChoice = { levelIndex: number; label: string };

export function VideoPlayer({ manifestUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [nativeOnly, setNativeOnly] = useState(false);
  const [levelChoices, setLevelChoices] = useState<LevelChoice[]>([]);
  const [selectedQuality, setSelectedQuality] = useState("auto");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setNativeOnly(false);
    setLevelChoices([]);
    setSelectedQuality("auto");
    hlsRef.current = null;

    const tryPlay = () => {
      void video.play().catch(() => {});
    };

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      const onManifestParsed = () => {
        const mapped: LevelChoice[] = hls.levels.map((l, levelIndex) => ({
          levelIndex,
          label:
            l.height > 0
              ? `${l.height}p`
              : `${Math.round((l.bitrate ?? 0) / 1000)} kb/s`,
        }));
        mapped.sort(
          (a, b) =>
            (hls.levels[b.levelIndex]?.height ?? 0) -
            (hls.levels[a.levelIndex]?.height ?? 0)
        );
        setLevelChoices(mapped);
        tryPlay();
      };

      hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);

      const onLevelSwitched = (_event: unknown, data: { level: number }) => {
        if (hls.autoLevelEnabled) {
          setSelectedQuality("auto");
        } else {
          setSelectedQuality(String(data.level));
        }
      };
      hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);

      return () => {
        hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
        hls.off(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
        hls.destroy();
        hlsRef.current = null;
        video.removeAttribute("src");
        video.load();
      };
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      setNativeOnly(true);
      video.src = manifestUrl;
      video.addEventListener("canplay", tryPlay);
      return () => {
        video.removeEventListener("canplay", tryPlay);
        video.removeAttribute("src");
        video.load();
      };
    }

    video.src = manifestUrl;
    video.addEventListener("canplay", tryPlay);
    return () => {
      video.removeEventListener("canplay", tryPlay);
      video.removeAttribute("src");
      video.load();
    };
  }, [manifestUrl]);

  const onQualityChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const hls = hlsRef.current;
      if (!hls) return;
      const v = e.target.value;
      if (v === "auto") {
        hls.currentLevel = -1;
      } else {
        hls.currentLevel = parseInt(v, 10);
      }
      setSelectedQuality(v);
    },
    []
  );

  const showQualityBar = nativeOnly || levelChoices.length > 1;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "stretch",
        maxWidth: 960,
        width: "100%",
      }}
    >
      {showQualityBar ? (
        <label
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            fontSize: "0.9rem",
            color: "#e0e0e0",
          }}
        >
          <span>Calidad</span>
          <select
            value={nativeOnly ? "auto" : selectedQuality}
            onChange={onQualityChange}
            disabled={nativeOnly || levelChoices.length <= 1}
            aria-label="Calidad de reproducción"
            style={{
              maxWidth: 220,
              padding: "6px 10px",
              borderRadius: 6,
              background: "#272727",
              color: "#f1f1f1",
              border: "1px solid #3a3a3a",
            }}
          >
            <option value="auto">Automático</option>
            {!nativeOnly &&
              levelChoices.map(({ levelIndex, label }) => (
                <option key={levelIndex} value={String(levelIndex)}>
                  {label}
                </option>
              ))}
          </select>
          {nativeOnly ? (
            <span style={{ color: "#999", fontSize: "0.85rem" }}>
              (solo automático en este navegador)
            </span>
          ) : null}
        </label>
      ) : null}
      <video
        ref={videoRef}
        controls
        playsInline
        style={{ width: "100%", background: "#111" }}
      />
    </div>
  );
}
