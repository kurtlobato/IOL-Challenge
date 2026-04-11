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
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class TranscodeService {

  private static final Logger log = LoggerFactory.getLogger(TranscodeService.class);

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

  /** Heavy work outside a DB transaction; commits success with {@link #saveReadyState}. */
  public void runPipeline(UUID videoId) throws Exception {
    Video meta =
        repo
            .findById(videoId)
            .orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (meta.getStatus() != VideoStatus.PROCESSING) {
      throw new IllegalStateException("Expected PROCESSING, got " + meta.getStatus());
    }
    Path tmp = Files.createTempDirectory("transcode-" + videoId);
    try {
      Path input = tmp.resolve("source");
      try (InputStream in = storage.getObject(meta.getOriginalObjectKey())) {
        Files.copy(in, input, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      }
      Path hlsDir = tmp.resolve("hls");
      Files.createDirectories(hlsDir);
      // FFmpeg coloca los .ts según el cwd: si no lo fijamos a hls/, los segmentos
      // pueden generarse en el directorio del proceso (p. ej. backend/) y no subirse a MinIO.
      List<String> cmd = new ArrayList<>();
      cmd.add(app.ffmpeg().command());
      cmd.addAll(
          List.of(
              "-y",
              "-i",
              input.toAbsolutePath().toString(),
              "-c:v",
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              "23",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-hls_time",
              "6",
              "-hls_playlist_type",
              "vod",
              "-hls_start_number",
              "0",
              "-hls_segment_filename",
              "seg%03d.ts",
              "-f",
              "hls",
              "index.m3u8"));
      ProcessBuilder pb = new ProcessBuilder(cmd);
      pb.directory(hlsDir.toFile());
      pb.redirectErrorStream(true);
      Process proc = pb.start();
      String ffmpegLog = new String(proc.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      int code = proc.waitFor();
      if (code != 0) {
        throw new IllegalStateException("ffmpeg exit " + code + ": " + truncate(ffmpegLog, 4000));
      }
      String prefix = "transcoded/" + videoId + "/";
      List<Path> outs;
      try (Stream<Path> walk = Files.walk(hlsDir)) {
        outs = walk.filter(Files::isRegularFile).toList();
      }
      for (Path p : outs) {
        String rel = hlsDir.relativize(p).toString().replace('\\', '/');
        String key = prefix + rel;
        storage.uploadFile(key, p, contentTypeForSegment(p));
      }
      videoService.markAsReady(videoId, prefix, prefix + "index.m3u8");
    } finally {
      deleteTree(tmp);
    }
  }

  private static String contentTypeForSegment(Path p) {
    String n = p.getFileName().toString().toLowerCase();
    if (n.endsWith(".m3u8")) {
      return "application/vnd.apple.mpegurl";
    }
    if (n.endsWith(".ts")) {
      return "video/mp2t";
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
