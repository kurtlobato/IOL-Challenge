package com.iol.video.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "app")
public record AppProperties(
    long maxUploadBytes,
    int presignTtlSeconds,
    String playbackBaseUrl,
    Transcode transcode,
    Ffmpeg ffmpeg) {

  public record Transcode(int maxRetries, long pollMs) {}

  public record Ffmpeg(String command) {}
}
