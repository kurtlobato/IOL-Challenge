import Hls from "hls.js";
import {
  ArrowLeft,
  FastForward,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rewind,
  Volume2,
  VolumeX,
} from "lucide-react";
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
  /** HLS (legado). */
  manifestUrl?: string | null;
  /** Reproducción directa (LAN / MP4). */
  streamUrl?: string | null;
  videoId: string;
  viewerKey: string;
  durationSeconds: number | null;
  /** Origen del API para registrar vistas en otro nodo. */
  viewApiOrigin?: string | null;
  onViewCountUpdated?: (viewCount: number) => void;
  title?: string;
  onBack?: () => void;
};

export function VideoPlayer({
  manifestUrl,
  streamUrl,
  videoId,
  viewerKey,
  durationSeconds,
  viewApiOrigin,
  onViewCountUpdated,
  title,
  onBack,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const viewCountedRef = useRef(false);
  const stitchedRef = useRef(resetStitchedTimeline());
  const maxEffectiveWatchedRef = useRef(0);
  const userSeekingRef = useRef(false);
  const onViewCb = useRef(onViewCountUpdated);
  onViewCb.current = onViewCountUpdated;

  const shellRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const volumeRailRef = useRef<HTMLDivElement>(null);
  const volumeScrubbingRef = useRef(false);
  const [shellInFullscreen, setShellInFullscreen] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volumeLevel, setVolumeLevel] = useState(1);
  const [volumeHovered, setVolumeHovered] = useState(false);
  const [volumeScrubbing, setVolumeScrubbing] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubbingRef = useRef(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimerRef = useRef<number | null>(null);

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimerRef.current != null) {
      window.clearTimeout(chromeTimerRef.current);
    }
    chromeTimerRef.current = window.setTimeout(() => {
      setChromeVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    // Keep controls visible when paused.
    if (!playing) {
      setChromeVisible(true);
      if (chromeTimerRef.current != null) window.clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = null;
    } else {
      showChrome();
    }
  }, [playing, showChrome]);

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
  }, [manifestUrl, streamUrl, videoId]);

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
    const onVol = () => {
      setMuted(video.muted);
      setVolumeLevel(video.volume);
    };
    video.addEventListener("timeupdate", sync);
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVol);
    setMuted(video.muted);
    setVolumeLevel(video.volume);
    sync();
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVol);
    };
  }, [manifestUrl, streamUrl, readDurationForUi]);

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
      void recordView(videoId, viewerKey, watched, viewApiOrigin ?? undefined)
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
  }, [durationSeconds, manifestUrl, streamUrl, videoId, viewerKey, viewApiOrigin]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    hlsRef.current = null;

    const tryPlay = () => {
      void video.play().catch(() => {});
    };

    if (streamUrl) {
      video.src = streamUrl;
      video.addEventListener("canplay", tryPlay);
      return () => {
        video.removeEventListener("canplay", tryPlay);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!manifestUrl) {
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(manifestUrl!);
      hls.attachMedia(video);

      const onManifestParsed = () => {
        tryPlay();
      };

      hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed);

      return () => {
        hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed);
        hls.destroy();
        hlsRef.current = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = manifestUrl!;
      video.addEventListener("canplay", tryPlay);
      return () => {
        video.removeEventListener("canplay", tryPlay);
        video.pause();
        video.removeAttribute("src");
        video.load();
      };
    }

    video.src = manifestUrl!;
    video.addEventListener("canplay", tryPlay);
    return () => {
      video.removeEventListener("canplay", tryPlay);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [manifestUrl, streamUrl]);

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

  const applyVolumeFromClientY = useCallback((clientY: number) => {
    const rail = volumeRailRef.current;
    const video = videoRef.current;
    if (!rail || !video) return;
    const rect = rail.getBoundingClientRect();
    const ratio = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
    video.volume = ratio;
    if (ratio > 0) video.muted = false;
    setVolumeLevel(video.volume);
    setMuted(video.muted);
  }, []);

  useEffect(() => {
    if (!volumeScrubbing) return;
    const onMove = (e: MouseEvent) => {
      applyVolumeFromClientY(e.clientY);
    };
    const onUp = () => {
      volumeScrubbingRef.current = false;
      setVolumeScrubbing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [volumeScrubbing, applyVolumeFromClientY]);

  const showVolumeFlyout = volumeHovered || volumeScrubbing;
  const iconSize = 26;
  const iconStroke = 2;

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
  }, [shellIsActiveFullscreen, manifestUrl, streamUrl]);

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
      className="video-player-root"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        alignItems: "stretch",
        width: "100%",
        maxWidth: "none",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        ref={shellRef}
        className={
          "detail-player-shell" +
          (shellInFullscreen ? " detail-player-shell--fullscreen" : "")
        }
        onMouseMove={() => showChrome()}
        onMouseLeave={() => {
          if (playing) setChromeVisible(false);
        }}
      >
        <div
          className={
            "detail-player-topbar" + (chromeVisible ? "" : " detail-player-chrome--hidden")
          }
        >
          <div className="detail-player-toprow detail-player-toprow--minimal">
            {onBack ? (
              <button
                type="button"
                className="detail-player-icon-btn detail-player-back"
                onClick={(e) => {
                  e.stopPropagation();
                  onBack();
                }}
                aria-label="Volver"
              >
                <ArrowLeft size={iconSize} strokeWidth={iconStroke} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <video
          ref={videoRef}
          controls={false}
          playsInline
          className="detail-player-video"
          onClick={() => {
            togglePlay();
          }}
        />
        <div className={"detail-player-chrome" + (chromeVisible ? "" : " detail-player-chrome--hidden")}>
          <div className="detail-player-seek-row">
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
            <span
              className="detail-player-time-remaining"
              aria-label="Tiempo restante"
              aria-hidden={progress.duration <= 0}
            >
              {progress.duration > 0
                ? formatVideoDurationHms(Math.max(0, progress.duration - progress.current))
                : "—"}
            </span>
          </div>
          <div className="detail-player-controls-row">
            <div className="detail-player-controls-cluster detail-player-controls-cluster--left">
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
                  <Pause size={iconSize} strokeWidth={iconStroke} aria-hidden />
                ) : (
                  <Play size={iconSize} strokeWidth={iconStroke} aria-hidden className="detail-player-icon-play" />
                )}
              </button>
              <button
                type="button"
                className="detail-player-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  const v = videoRef.current;
                  if (!v) return;
                  const d = readDurationForUi(v);
                  if (d <= 0) return;
                  v.currentTime = clamp(v.currentTime - 10, 0, d - 1e-3);
                  showChrome();
                }}
                aria-label="Retroceder 10 segundos"
              >
                <Rewind size={iconSize} strokeWidth={iconStroke} aria-hidden />
              </button>
              <button
                type="button"
                className="detail-player-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  const v = videoRef.current;
                  if (!v) return;
                  const d = readDurationForUi(v);
                  if (d <= 0) return;
                  v.currentTime = clamp(v.currentTime + 10, 0, d - 1e-3);
                  showChrome();
                }}
                aria-label="Adelantar 10 segundos"
              >
                <FastForward size={iconSize} strokeWidth={iconStroke} aria-hidden />
              </button>
              <div
                className="detail-player-volume-wrap"
                onMouseEnter={() => setVolumeHovered(true)}
                onMouseLeave={() => {
                  if (!volumeScrubbingRef.current) setVolumeHovered(false);
                }}
                onFocusCapture={() => setVolumeHovered(true)}
                onBlurCapture={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    if (!volumeScrubbingRef.current) setVolumeHovered(false);
                  }
                }}
              >
                {showVolumeFlyout ? (
                  <div className="detail-player-volume-popover">
                    <div
                      ref={volumeRailRef}
                      className="detail-player-volume-rail"
                      role="slider"
                      tabIndex={0}
                      aria-label="Volumen"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(volumeLevel * 100)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        volumeScrubbingRef.current = true;
                        setVolumeScrubbing(true);
                        applyVolumeFromClientY(e.clientY);
                      }}
                      onKeyDown={(e) => {
                        const v = videoRef.current;
                        if (!v) return;
                        const step = 0.05;
                        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
                          e.preventDefault();
                          const nv = clamp(v.volume + step, 0, 1);
                          v.volume = nv;
                          if (nv > 0) v.muted = false;
                          setVolumeLevel(v.volume);
                          setMuted(v.muted);
                        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          const nv = clamp(v.volume - step, 0, 1);
                          v.volume = nv;
                          if (nv > 0) v.muted = false;
                          setVolumeLevel(v.volume);
                          setMuted(v.muted);
                        }
                      }}
                    >
                      <div className="detail-player-volume-track">
                        <div
                          className="detail-player-volume-fill"
                          style={{ height: `${volumeLevel * 100}%` }}
                        />
                        <div
                          className="detail-player-volume-thumb"
                          style={{
                            bottom:
                              volumeLevel <= 0.001
                                ? "0px"
                                : `calc(${volumeLevel * 100}% - 6.5px)`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
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
                    <VolumeX size={iconSize} strokeWidth={iconStroke} aria-hidden />
                  ) : (
                    <Volume2 size={iconSize} strokeWidth={iconStroke} aria-hidden />
                  )}
                </button>
              </div>
            </div>
            {title ? (
              <div className="detail-player-title--center" title={title}>
                {title}
              </div>
            ) : (
              <div className="detail-player-title-spacer" aria-hidden />
            )}
            <div className="detail-player-controls-cluster detail-player-controls-cluster--right">
              <button
                type="button"
                className="detail-player-icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFullscreen();
                }}
                aria-label={shellInFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
              >
                {shellInFullscreen ? (
                  <Minimize size={iconSize} strokeWidth={iconStroke} aria-hidden />
                ) : (
                  <Maximize size={iconSize} strokeWidth={iconStroke} aria-hidden />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
