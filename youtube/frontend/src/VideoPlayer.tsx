import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { recordView } from "./api";
import { formatVideoDurationHms } from "./formatYoutubeStats";
import {
  nextStitchedTimelineState,
  readSeekableEndSeconds,
  resolveTotalDurationSeconds,
  resetStitchedTimeline,
} from "./viewPlaybackMetrics";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

type Props = {
  manifestUrl: string;
  videoId: string;
  viewerKey: string;
  durationSeconds: number | null;
  onViewCountUpdated?: (viewCount: number) => void;
};

type LevelChoice = { levelIndex: number; label: string };

export function VideoPlayer({
  manifestUrl,
  videoId,
  viewerKey,
  durationSeconds,
  onViewCountUpdated,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [nativeOnly, setNativeOnly] = useState(false);
  const [levelChoices, setLevelChoices] = useState<LevelChoice[]>([]);
  const [selectedQuality, setSelectedQuality] = useState("auto");
  const viewCountedRef = useRef(false);
  const stitchedRef = useRef(resetStitchedTimeline());
  const maxEffectiveWatchedRef = useRef(0);
  const userSeekingRef = useRef(false);
  const onViewCb = useRef(onViewCountUpdated);
  onViewCb.current = onViewCountUpdated;

  const shellRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [shellInFullscreen, setShellInFullscreen] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);

  const readDurationForUi = useCallback(
    (video: HTMLVideoElement) => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        return video.duration;
      }
      if (durationSeconds != null && durationSeconds > 0) {
        return durationSeconds;
      }
      return 0;
    },
    [durationSeconds]
  );

  useEffect(() => {
    viewCountedRef.current = false;
    stitchedRef.current = resetStitchedTimeline();
    maxEffectiveWatchedRef.current = 0;
    userSeekingRef.current = false;
    scrubbingRef.current = false;
    setScrubbing(false);
    setProgress({ current: 0, duration: 0 });
    setPlaying(false);
  }, [manifestUrl, videoId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => {
      if (scrubbingRef.current) return;
      const d = readDurationForUi(video);
      const c = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      setProgress((prev) => ({
        current: c,
        duration: d > 0 ? d : prev.duration,
      }));
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVol = () => setMuted(video.muted);
    video.addEventListener("timeupdate", sync);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVol);
    setMuted(video.muted);
    sync();
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVol);
    };
  }, [manifestUrl, readDurationForUi]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const durationFromHls = (): number | null => {
      const hls = hlsRef.current;
      if (!hls?.levels?.length) return null;
      const idx =
        hls.currentLevel >= 0
          ? hls.currentLevel
          : hls.loadLevel >= 0
            ? hls.loadLevel
            : 0;
      const level = hls.levels[idx] ?? hls.levels[0];
      const td = level?.details?.totalduration;
      return typeof td === "number" && Number.isFinite(td) && td > 0 ? td : null;
    };

    const onSeeking = () => {
      userSeekingRef.current = true;
    };
    const onSeeked = () => {
      userSeekingRef.current = false;
      stitchedRef.current = {
        ...stitchedRef.current,
        lastCurrent: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      };
    };

    const onTime = () => {
      if (viewCountedRef.current) return;
      if (userSeekingRef.current) return;

      stitchedRef.current = nextStitchedTimelineState(stitchedRef.current, video.currentTime);
      const { carried, lastCurrent } = stitchedRef.current;
      const effective = carried + lastCurrent;
      if (Number.isFinite(effective) && effective >= 0) {
        maxEffectiveWatchedRef.current = Math.max(maxEffectiveWatchedRef.current, effective);
      }

      const dur = resolveTotalDurationSeconds(
        durationSeconds,
        video.duration,
        readSeekableEndSeconds(video),
        durationFromHls(),
      );
      if (dur == null || dur <= 0) return;
      const watched = maxEffectiveWatchedRef.current;
      if (watched + 1e-3 < dur * 0.1) return;
      viewCountedRef.current = true;
      void recordView(videoId, viewerKey, watched)
        .then((c) => onViewCb.current?.(c))
        .catch(() => {
          viewCountedRef.current = false;
        });
    };
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", onTime);
    return () => {
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [durationSeconds, manifestUrl, videoId, viewerKey]);

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

  const seekToClientX = useCallback(
    (clientX: number) => {
      const rail = railRef.current;
      const video = videoRef.current;
      if (!rail || !video) return;
      const d = readDurationForUi(video);
      if (d <= 0) return;
      const rect = rail.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const t = ratio * d;
      const clamped = clamp(t, 0, d - 1e-3);
      video.currentTime = clamped;
      setProgress({ current: clamped, duration: d });
    },
    [readDurationForUi]
  );

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: MouseEvent) => {
      seekToClientX(e.clientX);
    };
    const onUp = () => {
      scrubbingRef.current = false;
      setScrubbing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [scrubbing, seekToClientX]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const shellIsActiveFullscreen = useCallback(() => {
    const el = shellRef.current;
    if (!el) return false;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
    };
    return (
      document.fullscreenElement === el ||
      doc.webkitFullscreenElement === el ||
      doc.mozFullScreenElement === el
    );
  }, []);

  useEffect(() => {
    const sync = () => setShellInFullscreen(shellIsActiveFullscreen());
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    document.addEventListener("mozfullscreenchange", sync);
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      document.removeEventListener("mozfullscreenchange", sync);
    };
  }, [shellIsActiveFullscreen, manifestUrl]);

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    if (!shellIsActiveFullscreen()) {
      if (el.requestFullscreen) {
        void el.requestFullscreen().catch(() => {});
        return;
      }
      const wk = (el as unknown as { webkitRequestFullscreen?: () => void })
        .webkitRequestFullscreen;
      if (wk) wk.call(el);
    } else if (document.exitFullscreen) {
      void document.exitFullscreen().catch(() => {});
    } else {
      const wk = (document as unknown as { webkitExitFullscreen?: () => void })
        .webkitExitFullscreen;
      if (wk) wk.call(document);
    }
  }, [shellIsActiveFullscreen]);

  const playedPct =
    progress.duration > 0 ? (progress.current / progress.duration) * 100 : 0;

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
      <div
        ref={shellRef}
        className={
          "detail-player-shell" +
          (shellInFullscreen ? " detail-player-shell--fullscreen" : "")
        }
      >
        <video
          ref={videoRef}
          controls={false}
          playsInline
          className="detail-player-video"
          onClick={() => {
            togglePlay();
          }}
        />
        <div className="detail-player-chrome">
          <button
            type="button"
            className="detail-player-icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            aria-label={playing ? "Pausa" : "Reproducir"}
          >
            {playing ? (
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <div className="detail-player-seek-wrap">
            <div
              ref={railRef}
              className="detail-player-rail"
              role="slider"
              tabIndex={0}
              aria-label="Posición en el video"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, progress.duration)}
              aria-valuenow={progress.current}
              onMouseDown={(e) => {
                e.preventDefault();
                scrubbingRef.current = true;
                setScrubbing(true);
                seekToClientX(e.clientX);
              }}
              onKeyDown={(e) => {
                const video = videoRef.current;
                if (!video) return;
                const d = readDurationForUi(video);
                if (d <= 0) return;
                const step = Math.min(10, d * 0.05);
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  video.currentTime = clamp(video.currentTime - step, 0, d - 1e-3);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  video.currentTime = clamp(video.currentTime + step, 0, d - 1e-3);
                }
              }}
            >
              <div className="detail-player-rail-track" />
              <div
                className="detail-player-rail-played"
                style={{ width: `${playedPct}%` }}
              />
              <div
                className="detail-player-rail-handle"
                style={{ left: `${playedPct}%` }}
              />
            </div>
          </div>
          <span className="detail-player-time" aria-live="polite">
            {formatVideoDurationHms(progress.current)} /{" "}
            {formatVideoDurationHms(progress.duration)}
          </span>
          <button
            type="button"
            className="detail-player-icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              toggleMute();
            }}
            aria-label={muted ? "Activar sonido" : "Silenciar"}
          >
            {muted ? (
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="detail-player-icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            aria-label="Pantalla completa"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
