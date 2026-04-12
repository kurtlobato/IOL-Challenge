package com.iol.video.service;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.storage.ObjectStorageService;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Orquesta descarga del original, ffmpeg (miniatura + variantes HLS), subida a objeto y cierre en
 * estado {@link com.iol.video.domain.VideoStatus#READY}.
 */
@Service
public class TranscodeService {

  private static final Logger log = LoggerFactory.getLogger(TranscodeService.class);

  private static final int AUDIO_BPS = 128_000;

  private final ObjectStorageService storage;
  private final AppProperties app;
  private final VideoService videoService;

  public TranscodeService(
      ObjectStorageService storage, AppProperties app, VideoService videoService) {
    this.storage = storage;
    this.app = app;
    this.videoService = videoService;
  }

  private static String abbrevTitle(String title) {
    if (title == null) {
      return "";
    }
    String t = title.replace('\n', ' ').trim();
    return t.length() <= 120 ? t : t.substring(0, 120) + "…";
  }

  /**
   * Trabajo pesado fuera de transacción JPA larga. Renueva periódicamente el lease de procesamiento
   * para que un worker caído no bloquee el video indefinidamente; al terminar llama a {@link
   * VideoService#markAsReady}.
   *
   * @throws IllegalArgumentException si no existe el video
   * @throws IllegalStateException si el estado no es {@code PROCESSING}
   */
  public void runPipeline(UUID videoId) throws Exception {
    Video meta = videoService.requireProcessingForTranscode(videoId);
    log.info(
        "Pipeline inicio: videoId={} título=\"{}\" variantesHls={} originalKey={}",
        videoId,
        abbrevTitle(meta.getTitle()),
        app.hlsVariants().size(),
        meta.getOriginalObjectKey());
    ScheduledExecutorService leaseRenewer =
        Executors.newSingleThreadScheduledExecutor(
            r -> {
              Thread t = new Thread(r, "transcode-lease-" + videoId);
              t.setDaemon(true);
              return t;
            });
    ScheduledFuture<?> renewJob = null;
    try {
      videoService.extendProcessingLease(videoId);
      renewJob =
          leaseRenewer.scheduleAtFixedRate(
              () -> {
                try {
                  videoService.extendProcessingLease(videoId);
                } catch (Exception e) {
                  log.debug("Lease renew: {}", e.getMessage());
                }
              },
              app.transcode().leaseRenewSeconds(),
              app.transcode().leaseRenewSeconds(),
              TimeUnit.SECONDS);
      Path tmp = Files.createTempDirectory("transcode-" + videoId);
      try {
        Path input = tmp.resolve("source");
        log.info("Descarga original desde storage: videoId={}", videoId);
        try (InputStream in = storage.getObject(meta.getOriginalObjectKey())) {
          Files.copy(in, input, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        long inputBytes = Files.size(input);
        log.info("Original en disco: videoId={} bytes={}", videoId, inputBytes);
        Double probed = probeDurationSeconds(input);
        if (probed != null) {
          videoService.setDurationSeconds(videoId, probed);
          log.info("ffprobe duración: videoId={} segundos≈{}", videoId, probed);
        } else {
          log.info("ffprobe duración: videoId={} (no disponible)", videoId);
        }
        videoService.setTranscodeProgress(videoId, 12);
        Path hlsDir = tmp.resolve("hls");
        Files.createDirectories(hlsDir);

        Path thumbnail = hlsDir.resolve("thumbnail.jpg");
        runFfmpegThumbnail(input, thumbnail);

        String prefix = "transcoded/" + videoId + "/";
        if (Files.isRegularFile(thumbnail)) {
          String thumbKey = prefix + "thumbnail.jpg";
          storage.uploadFile(thumbKey, thumbnail, "image/jpeg");
          videoService.setTranscodeOutputPrefix(videoId, prefix);
          videoService.setTranscodeProgress(videoId, 28);
          log.info("Miniatura generada y subida: videoId={} key={}", videoId, thumbKey);
        } else {
          videoService.setTranscodeProgress(videoId, 25);
          log.info("Miniatura omitida (ffmpeg sin archivo): videoId={}", videoId);
        }

        List<AppProperties.HlsVariant> variants = app.hlsVariants();
        int n = variants.size();
        for (int i = 0; i < n; i++) {
          AppProperties.HlsVariant v = variants.get(i);
          log.info(
              "Variante HLS {}/{}: videoId={} nombre={} height={}",
              i + 1,
              n,
              videoId,
              v.name(),
              v.height());
          Path variantDir = hlsDir.resolve(v.name());
          Files.createDirectories(variantDir);
          runFfmpegVariant(input, variantDir, v);
          int pct = 28 + (int) Math.round(55.0 * (i + 1) / n);
          videoService.setTranscodeProgress(videoId, Math.min(pct, 83));
        }
        videoService.setTranscodeProgress(videoId, 85);
        String masterBody = buildMasterPlaylist(variants);
        Files.writeString(hlsDir.resolve("master.m3u8"), masterBody, StandardCharsets.UTF_8);

        List<Path> outs;
        try (Stream<Path> walk = Files.walk(hlsDir)) {
          outs = walk.filter(Files::isRegularFile).toList();
        }
        long tsCount =
            outs.stream()
                .map(p -> p.getFileName().toString().toLowerCase())
                .filter(fn -> fn.endsWith(".ts"))
                .count();
        int totalOut = outs.size();
        log.info(
            "Subida artefactos HLS: videoId={} archivosTotales={} segmentosTs={}",
            videoId,
            totalOut,
            tsCount);
        int step = Math.max(1, totalOut / 10);
        for (int fi = 0; fi < outs.size(); fi++) {
          Path p = outs.get(fi);
          String rel = hlsDir.relativize(p).toString().replace('\\', '/');
          String key = prefix + rel;
          storage.uploadFile(key, p, contentTypeForSegment(p));
          int oneBased = fi + 1;
          if (totalOut <= 24
              || oneBased == 1
              || oneBased == totalOut
              || oneBased % step == 0) {
            log.info(
                "Subida progreso: videoId={} {}/{} rel={}",
                videoId,
                oneBased,
                totalOut,
                rel);
          }
        }
        videoService.setTranscodeProgress(videoId, 95);
        videoService.markAsReady(videoId, prefix, prefix + "master.m3u8");
        log.info(
            "Pipeline fin OK: videoId={} prefijoSalida={} manifest={}",
            videoId,
            prefix,
            prefix + "master.m3u8");
      } finally {
        deleteTree(tmp);
      }
    } finally {
      if (renewJob != null) {
        renewJob.cancel(false);
      }
      leaseRenewer.shutdown();
      try {
        if (!leaseRenewer.awaitTermination(5, TimeUnit.SECONDS)) {
          leaseRenewer.shutdownNow();
        }
      } catch (InterruptedException ie) {
        leaseRenewer.shutdownNow();
        Thread.currentThread().interrupt();
      }
    }
  }

  private Double probeDurationSeconds(Path input) {
    try {
      List<String> cmd = new ArrayList<>();
      cmd.add(ffprobeBinary());
      cmd.addAll(
          List.of(
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "default=noprint_wrappers=1:nokey=1",
              input.toAbsolutePath().toString()));
      ProcessBuilder pb = new ProcessBuilder(cmd);
      pb.redirectErrorStream(true);
      Process proc = pb.start();
      long sec = Math.min(120L, app.transcode().ffmpegThumbnailTimeoutSeconds());
      if (!proc.waitFor(sec, TimeUnit.SECONDS)) {
        destroyFfmpegProcess(proc);
        log.warn("ffprobe duration exceeded {}s timeout", sec);
        return null;
      }
      String out = new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
      if (out.isEmpty()) {
        return null;
      }
      return Double.parseDouble(out);
    } catch (Exception e) {
      log.warn("ffprobe duration failed: {}", e.getMessage());
      return null;
    }
  }

  private String ffprobeBinary() {
    String ffmpeg = app.ffmpeg().command();
    if (ffmpeg.endsWith("ffmpeg")) {
      return ffmpeg.substring(0, ffmpeg.length() - 6) + "ffprobe";
    }
    return "ffprobe";
  }

  private void runFfmpegThumbnail(Path input, Path output) {
    try {
      List<String> cmd = new ArrayList<>();
      cmd.add(app.ffmpeg().command());
      cmd.addAll(
          List.of(
              "-y",
              "-i",
              input.toAbsolutePath().toString(),
              "-ss",
              "00:00:01.000",
              "-vframes",
              "1",
              "-q:v",
              "2",
              output.toAbsolutePath().toString()));
      ProcessBuilder pb = new ProcessBuilder(cmd);
      pb.redirectErrorStream(true);
      Process proc = pb.start();
      long sec = app.transcode().ffmpegThumbnailTimeoutSeconds();
      if (!proc.waitFor(sec, TimeUnit.SECONDS)) {
        destroyFfmpegProcess(proc);
        log.warn("Thumbnail ffmpeg exceeded {}s timeout", sec);
      } else {
        drainFfmpegLog(proc);
      }
    } catch (Exception e) {
      log.warn("Failed to generate thumbnail: {}", e.getMessage());
    }
  }

  /**
   * Codifica una variante HLS VOD en {@code variantDir} (cwd de ffmpeg). Los .ts van junto a
   * {@code index.m3u8}: con subcarpeta, ffmpeg escribe bien los archivos pero el playlist referencia
   * solo {@code segNNN.ts} y el reproductor pide rutas incorrectas (404).
   */
  private void runFfmpegVariant(Path input, Path variantDir, AppProperties.HlsVariant v)
      throws Exception {
    int videoBps = Math.max(256_000, v.bandwidthBps() - AUDIO_BPS);
    String maxrateK = (videoBps + 999) / 1000 + "k";
    String bufK = (videoBps * 2 + 999) / 1000 + "k";
    List<String> cmd = new ArrayList<>();
    cmd.add(app.ffmpeg().command());
    cmd.addAll(
        List.of(
            "-y",
            "-i",
            input.toAbsolutePath().toString(),
            "-vf",
            "scale=-2:" + v.height(),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-maxrate",
            maxrateK,
            "-bufsize",
            bufK,
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-hls_time",
            "6",
            "-hls_playlist_type",
            "vod",
            "-hls_segment_filename",
            "seg%03d.ts",
            "-f",
            "hls",
            "index.m3u8"));
    ProcessBuilder pb = new ProcessBuilder(cmd);
    pb.directory(variantDir.toFile());
    pb.redirectErrorStream(true);
    Process proc = pb.start();
    long sec = app.transcode().ffmpegTimeoutSeconds();
    if (!proc.waitFor(sec, TimeUnit.SECONDS)) {
      destroyFfmpegProcess(proc);
      throw new TimeoutException("ffmpeg exceeded " + sec + "s (" + v.name() + ")");
    }
    String ffmpegLog = drainFfmpegLog(proc);
    int code = proc.exitValue();
    if (code != 0) {
      throw new IllegalStateException(
          "ffmpeg exit "
              + code
              + " ("
              + v.name()
              + "): "
              + truncate(ffmpegLog, 4000));
    }
  }

  private static String drainFfmpegLog(Process proc) throws java.io.IOException {
    return new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
  }

  /** Termina ffmpeg de forma ordenada y, si no responde, fuerza la destrucción del proceso. */
  private static void destroyFfmpegProcess(Process proc) {
    proc.destroy();
    try {
      if (!proc.waitFor(5, TimeUnit.SECONDS)) {
        proc.destroyForcibly();
        proc.waitFor(3, TimeUnit.SECONDS);
      }
    } catch (InterruptedException ie) {
      Thread.currentThread().interrupt();
      proc.destroyForcibly();
    }
  }

  /** Master playlist for adaptive HLS (Apple-style multivariant). */
  static String buildMasterPlaylist(List<AppProperties.HlsVariant> variants) {
    StringBuilder sb = new StringBuilder();
    sb.append("#EXTM3U\n#EXT-X-VERSION:3\n");
    for (AppProperties.HlsVariant v : variants) {
      int w = evenWidth16x9(v.height());
      int totalBps = v.bandwidthBps() + AUDIO_BPS;
      sb.append("#EXT-X-STREAM-INF:BANDWIDTH=").append(totalBps);
      sb.append(",RESOLUTION=").append(w).append('x').append(v.height()).append('\n');
      sb.append(v.name()).append("/index.m3u8\n");
    }
    return sb.toString();
  }

  /** Typical display width for 16:9 at a given height (even pixels). */
  static int evenWidth16x9(int height) {
    int w = (int) Math.round(height * 16.0 / 9);
    if ((w & 1) != 0) {
      w++;
    }
    return w;
  }

  private static String contentTypeForSegment(Path p) {
    String n = p.getFileName().toString().toLowerCase();
    if (n.endsWith(".m3u8")) {
      return "application/vnd.apple.mpegurl";
    }
    if (n.endsWith(".ts")) {
      return "video/mp2t";
    }
    if (n.endsWith(".jpg")) {
      return "image/jpeg";
    }
    return "application/octet-stream";
  }

  /** Borra un directorio temporal de forma best-effort (profundidad descendente para vaciar bien). */
  private static void deleteTree(Path root) {
    try {
      if (Files.exists(root)) {
        try (Stream<Path> w = Files.walk(root)) {
          w.sorted((a, b) -> b.getNameCount() - a.getNameCount())
              .forEach(
                  p -> {
                    try {
                      Files.deleteIfExists(p);
                    } catch (Exception e) {
                      log.debug("No se pudo borrar {}: {}", p, e.getMessage());
                    }
                  });
        }
      }
    } catch (Exception e) {
      log.debug("Cleanup temp failed: {}", e.getMessage());
    }
  }

  private static String truncate(String s, int max) {
    if (s == null) {
      return "";
    }
    return s.length() <= max ? s : s.substring(0, max) + "...";
  }
}
