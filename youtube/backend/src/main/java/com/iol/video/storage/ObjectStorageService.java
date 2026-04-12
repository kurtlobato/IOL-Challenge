package com.iol.video.storage;

import com.iol.video.config.MinioProperties;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import io.github.resilience4j.timelimiter.TimeLimiter;
import io.github.resilience4j.timelimiter.TimeLimiterRegistry;
import io.minio.GetObjectArgs;
import io.minio.GetPresignedObjectUrlArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import io.minio.StatObjectArgs;
import io.minio.http.Method;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Callable;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;

/**
 * Acceso a MinIO envuelto en circuit breaker y time limiter (misma clave {@value #MINIO} en
 * Resilience4j) para no bloquear hilos de request ante lentitud o fallos en cascada.
 */
@Service
public class ObjectStorageService {

  private static final String MINIO = "minio";

  private final MinioClient client;
  private final MinioProperties props;
  private final CircuitBreakerRegistry circuitBreakerRegistry;
  private final TimeLimiterRegistry timeLimiterRegistry;
  private final ScheduledExecutorService resilienceScheduler;

  public ObjectStorageService(
      MinioClient client,
      MinioProperties props,
      CircuitBreakerRegistry circuitBreakerRegistry,
      TimeLimiterRegistry timeLimiterRegistry,
      ScheduledExecutorService minioResilienceScheduler) {
    this.client = client;
    this.props = props;
    this.circuitBreakerRegistry = circuitBreakerRegistry;
    this.timeLimiterRegistry = timeLimiterRegistry;
    this.resilienceScheduler = minioResilienceScheduler;
  }

  public String presignedPut(String objectKey, int ttlSeconds) throws Exception {
    return executeMinio(
        () ->
            client.getPresignedObjectUrl(
                GetPresignedObjectUrlArgs.builder()
                    .method(Method.PUT)
                    .bucket(props.bucket())
                    .object(objectKey)
                    .expiry(ttlSeconds, TimeUnit.SECONDS)
                    .build()));
  }

  public boolean objectExists(String objectKey) {
    try {
      client.statObject(
          StatObjectArgs.builder().bucket(props.bucket()).object(objectKey).build());
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  public void uploadFile(String objectKey, Path file, String contentType) throws Exception {
    executeMinio(
        () -> {
          long size = Files.size(file);
          try (InputStream in = Files.newInputStream(file)) {
            client.putObject(
                PutObjectArgs.builder()
                    .bucket(props.bucket())
                    .object(objectKey)
                    .stream(in, size, -1)
                    .contentType(
                        contentType != null ? contentType : "application/octet-stream")
                    .build());
          }
          return null;
        });
  }

  public void uploadStream(String objectKey, InputStream in, long size, String contentType)
      throws Exception {
    executeMinio(
        () -> {
          client.putObject(
              PutObjectArgs.builder()
                  .bucket(props.bucket())
                  .object(objectKey)
                  .stream(in, size, -1)
                  .contentType(
                      contentType != null ? contentType : "application/octet-stream")
                  .build());
          return null;
        });
  }

  public InputStream getObject(String objectKey) throws Exception {
    return executeMinio(
        () ->
            client.getObject(
                GetObjectArgs.builder().bucket(props.bucket()).object(objectKey).build()));
  }

  public String bucket() {
    return props.bucket();
  }

  /**
   * URL pública de lectura directa (p. ej. detrás de nginx) concatenando base, bucket y clave de
   * objeto.
   */
  public String publicUrlForKey(String objectKey, String playbackBaseUrl) {
    String base =
        playbackBaseUrl.endsWith("/")
            ? playbackBaseUrl.substring(0, playbackBaseUrl.length() - 1)
            : playbackBaseUrl;
    return base + "/" + props.bucket() + "/" + objectKey;
  }

  /**
   * Ejecuta la llamada en un hilo del scheduler dedicado para que {@link TimeLimiter} pueda
   * cancelar la espera; el {@link CircuitBreaker} envuelve esa ejecución acotada en tiempo.
   */
  private <T> T executeMinio(Callable<T> call) throws Exception {
    CircuitBreaker cb = circuitBreakerRegistry.circuitBreaker(MINIO);
    TimeLimiter tl = timeLimiterRegistry.timeLimiter(MINIO);
    Supplier<java.util.concurrent.Future<T>> futureSupplier =
        () -> resilienceScheduler.submit(call::call);
    Callable<T> timed = TimeLimiter.decorateFutureSupplier(tl, futureSupplier);
    return cb.executeCallable(timed);
  }
}
