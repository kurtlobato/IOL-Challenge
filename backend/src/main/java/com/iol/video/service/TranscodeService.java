package com.iol.video.service;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.repo.VideoRepository;
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
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class TranscodeService {

  private static final Logger log = LoggerFactory.getLogger(TranscodeService.class);

  private static final int AUDIO_BPS = 128_000;

  /** Subcarpeta por variante HLS para segmentos (.ts), separados del index.m3u8. */
  private static final String HLS_SEGMENT_SUBDIR = "segments";

  private final VideoRepository repo;
  private final ObjectStorageService storage;
  private final AppProperties app;
  private final VideoService videoService;

  public TranscodeService(
      VideoRepository repo,
      ObjectStorageService storage,
      AppProperties app,
      VideoService videoService) {
    this.repo = repo;
    this.storage = storage;
    this.app = app;
    this.videoService = videoService;
  }

  /** Heavy work outside a DB transaction; commits success with {@link VideoService#markAsReady}. */
  public void runPipeline(UUID videoId) throws Exception {
    Video meta =
        repo
            .findById(videoId)
            .orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (meta.getStatus() != VideoStatus.PROCESSING) {
      throw new IllegalStateException("Expected PROCESSING, got " + meta.getStatus());
    }
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
        try (InputStream in = storage.getObject(meta.getOriginalObjectKey())) {
          Files.copy(in, input, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        Path hlsDir = tmp.resolve("hls");
        Files.createDirectories(hlsDir);

        Path thumbnail = hlsDir.resolve("thumbnail.jpg");
        runFfmpegThumbnail(input, thumbnail);

        String prefix = "transcoded/" + videoId + "/";
        if (Files.isRegularFile(thumbnail)) {
          String thumbKey = prefix + "thumbnail.jpg";
          storage.uploadFile(thumbKey, thumbnail, "image/jpeg");
          videoService.setTranscodeOutputPrefix(videoId, prefix);
        }

        List<AppProperties.HlsVariant> variants = app.hlsVariants();
        for (AppProperties.HlsVariant v : variants) {
          Path variantDir = hlsDir.resolve(v.name());
          Files.createDirectories(variantDir);
          Files.createDirectories(variantDir.resolve(HLS_SEGMENT_SUBDIR));
          runFfmpegVariant(input, variantDir, v);
        }
        String masterBody = buildMasterPlaylist(variants);
        Files.writeString(hlsDir.resolve("master.m3u8"), masterBody, StandardCharsets.UTF_8);

        List<Path> outs;
        try (Stream<Path> walk = Files.walk(hlsDir)) {
          outs = walk.filter(Files::isRegularFile).toList();
        }
        for (Path p : outs) {
          String rel = hlsDir.relativize(p).toString().replace('\\', '/');
          String key = prefix + rel;
          storage.uploadFile(key, p, contentTypeForSegment(p));
        }
        videoService.markAsReady(videoId, prefix, prefix + "master.m3u8");
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

  private void runFfmpegThumbnail(Path input, Path output) {
    try {
      List<String> cmd = new ArrayList<>();
      cmd.add(app.ffmpeg().command());
      cmd.addAll(List.of(
          "-y",
          "-i", input.toAbsolutePath().toString(),
          "-ss", "00:00:01.000",
          "-vframes", "1",
          "-q:v", "2",
          output.toAbsolutePath().toString()
      ));
      ProcessBuilder pb = new ProcessBuilder(cmd);
      pb.redirectErrorStream(true);
      Process proc = pb.start();
      proc.waitFor();
    } catch (Exception e) {
      log.warn("Failed to generate thumbnail: {}", e.getMessage());
    }
  }

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
            HLS_SEGMENT_SUBDIR + "/seg%03d.ts",
            "-f",
            "hls",
            "index.m3u8"));
    ProcessBuilder pb = new ProcessBuilder(cmd);
    pb.directory(variantDir.toFile());
    pb.redirectErrorStream(true);
    Process proc = pb.start();
    String ffmpegLog = new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    int code = proc.waitFor();
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

  private static void deleteTree(Path root) {
    try {
      if (Files.exists(root)) {
        try (Stream<Path> w = Files.walk(root)) {
          w.sorted((a, b) -> b.getNameCount() - a.getNameCount())
              .forEach(
                  p -> {
                    try {
                      Files.deleteIfExists(p);
                    } catch (Exception ignored) {
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
