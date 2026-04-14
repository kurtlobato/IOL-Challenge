package com.iol.video.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
    long maxUploadBytes,
    int presignTtlSeconds,
    String playbackBaseUrl,
    Transcode transcode,
    Ffmpeg ffmpeg,
    List<HlsVariant> hlsVariants,
    StaleCreatedCleanup staleCreatedCleanup) {

  public AppProperties {
    if (transcode == null) {
      transcode = new Transcode(3, 4000L, 120, 45, 45, 7200, 180);
    }
    if (ffmpeg == null) {
      ffmpeg = new Ffmpeg("ffmpeg", "auto");
    }
    if (hlsVariants == null || hlsVariants.isEmpty()) {
      hlsVariants =
          List.of(
              new HlsVariant("480p", 480, 1_000_000),
              new HlsVariant("720p", 720, 3_000_000));
    }
    if (staleCreatedCleanup == null) {
      staleCreatedCleanup = new StaleCreatedCleanup(24, 3_600_000L);
    }
  }

  public record Transcode(
      int maxRetries,
      long pollMs,
      int leaseTtlSeconds,
      int leaseRenewSeconds,
      int claimLockAtMostSeconds,
      int ffmpegTimeoutSeconds,
      int ffmpegThumbnailTimeoutSeconds) {
    public Transcode {
      if (leaseTtlSeconds <= 0) {
        leaseTtlSeconds = 120;
      }
      if (leaseRenewSeconds <= 0) {
        leaseRenewSeconds = 45;
      }
      if (leaseRenewSeconds >= leaseTtlSeconds) {
        leaseRenewSeconds = Math.max(15, leaseTtlSeconds / 2);
      }
      if (claimLockAtMostSeconds <= 0) {
        claimLockAtMostSeconds = 45;
      }
      if (ffmpegTimeoutSeconds <= 0) {
        ffmpegTimeoutSeconds = 7200;
      }
      if (ffmpegThumbnailTimeoutSeconds <= 0) {
        ffmpegThumbnailTimeoutSeconds = 180;
      }
    }
  }

  public record Ffmpeg(String command, String hardwareAccel) {
    public Ffmpeg {
      if (command == null || command.isBlank()) {
        command = "ffmpeg";
      }
      if (hardwareAccel == null || hardwareAccel.isBlank()) {
        hardwareAccel = "auto";
      }
    }

    /** For tests: default {@code hardware-accel=auto}. */
    public Ffmpeg(String command) {
      this(command, "auto");
    }
  }

  /**
   * Limpieza de filas {@code CREATED} abandonadas: edad mínima y frecuencia del job ({@code poll-ms},
   * fixed delay).
   */
  public record StaleCreatedCleanup(int maxAgeHours, long pollMs) {
    public StaleCreatedCleanup {
      if (maxAgeHours <= 0) {
        maxAgeHours = 24;
      }
      if (pollMs <= 0) {
        pollMs = 3_600_000L;
      }
    }
  }

  /** One HLS ladder rung: output under {@code hls/{name}/index.m3u8}; bandwidth for master playlist. */
  public record HlsVariant(String name, int height, int bandwidthBps) {}
}
