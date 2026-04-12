package com.iol.video.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "minio")
public record MinioProperties(
    String endpoint,
    String accessKey,
    String secretKey,
    String bucket,
    String region,
    Http http) {

  public record Http(int connectTimeoutMillis, int readTimeoutMillis, int writeTimeoutMillis) {
    public Http {
      if (connectTimeoutMillis <= 0) {
        connectTimeoutMillis = 10_000;
      }
      if (readTimeoutMillis <= 0) {
        readTimeoutMillis = 600_000;
      }
      if (writeTimeoutMillis <= 0) {
        writeTimeoutMillis = 600_000;
      }
    }
  }

  public MinioProperties {
    if (http == null) {
      http = new Http(10_000, 600_000, 600_000);
    }
  }
}
