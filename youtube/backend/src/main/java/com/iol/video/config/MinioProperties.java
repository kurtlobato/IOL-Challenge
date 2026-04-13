package com.iol.video.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "minio")
public record MinioProperties(
    /** URL que usa el API para operaciones S3 (en Docker suele ser el hostname del servicio, p. ej. {@code http://minio:9000}). */
    String endpoint,
    /**
     * URL base para URLs presignadas devueltas al navegador. Si no se define, se usa {@link
     * #endpoint()}. Debe ser alcanzable desde el cliente (p. ej. {@code http://localhost:9000} con
     * el puerto publicado en el host).
     */
    String publicEndpoint,
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
    if (publicEndpoint != null && publicEndpoint.isBlank()) {
      publicEndpoint = null;
    }
  }
}
