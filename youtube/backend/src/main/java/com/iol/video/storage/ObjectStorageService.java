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
import io.minio.RemoveObjectArgs;
import io.minio.StatObjectArgs;
import io.minio.errors.ErrorResponseException;
import io.minio.http.Method;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Callable;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Acceso a MinIO envuelto en circuit breaker y time limiter (misma clave {@value #MINIO} en
 * Resilience4j) para no bloquear hilos de request ante lentitud o fallos en cascada.
 */
@Service
public class ObjectStorageService {

  private static final Logger log = LoggerFactory.getLogger(ObjectStorageService.class);
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

  public String presignedGet(String objectKey, int ttlSeconds) throws Exception {
    return executeMinio(
        () ->
            client.getPresignedObjectUrl(
                GetPresignedObjectUrlArgs.builder()
                    .method(Method.GET)
                    .bucket(props.bucket())
                    .object(objectKey)
                    .expiry(ttlSeconds, TimeUnit.SECONDS)
                    .build()));
  }

  /**
   * Comprueba por HEAD/stat que el objeto exista, bajo circuit breaker y time limiter.
   *
   * <p>Si MinIO responde objeto inexistente, lanza {@link IllegalStateException} con mensaje
   * estable. Cualquier otro fallo (red, credenciales, circuito abierto, timeout) se propaga para
   * que el límite HTTP pueda mapearlo.
   */
  public void ensureObjectPresent(String objectKey) throws Exception {
    try {
      executeMinio(
          () -> {
            client.statObject(
                StatObjectArgs.builder().bucket(props.bucket()).object(objectKey).build());
            return null;
          });
    } catch (Exception e) {
      ErrorResponseException ere = findErrorResponse(e);
      if (ere != null && isObjectNotFound(ere)) {
        throw new IllegalStateException("Original object not found in storage");
      }
      throw e;
    }
  }

  private static ErrorResponseException findErrorResponse(Throwable t) {
    while (t != null) {
      if (t instanceof ErrorResponseException ere) {
        return ere;
      }
      t = t.getCause();
    }
    return null;
  }

  private static boolean isObjectNotFound(ErrorResponseException ere) {
    if (ere.errorResponse() == null) {
      return false;
    }
    String code = ere.errorResponse().code();
    return "NoSuchKey".equals(code) || "NotFound".equals(code);
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

  /**
   * Borra el objeto en el bucket; ignora ausencia. Otros fallos se registran y no se propagan para
   * no bloquear limpieza en BD.
   */
  public void removeObjectBestEffort(String objectKey) {
    try {
      executeMinio(
          () -> {
            client.removeObject(
                RemoveObjectArgs.builder().bucket(props.bucket()).object(objectKey).build());
            return null;
          });
    } catch (Exception e) {
      log.warn("removeObjectBestEffort {}: {}", objectKey, e.getMessage());
    }
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
