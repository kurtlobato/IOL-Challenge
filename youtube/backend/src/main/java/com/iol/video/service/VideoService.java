package com.iol.video.service;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.repo.VideoRepository;
import com.iol.video.storage.ObjectStorageService;
import com.iol.video.web.dto.CreateVideoRequest;
import com.iol.video.web.dto.CreateVideoResponse;
import com.iol.video.web.dto.VideoDto;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Casos de uso de video: alta con presign, completado, listado y transición a procesamiento/ready. */
@Service
public class VideoService {

  private static final Logger log = LoggerFactory.getLogger(VideoService.class);

  private final VideoRepository repo;
  private final ObjectStorageService storage;
  private final AppProperties app;

  public VideoService(VideoRepository repo, ObjectStorageService storage, AppProperties app) {
    this.repo = repo;
    this.storage = storage;
    this.app = app;
  }

  @Transactional
  public CreateVideoResponse create(CreateVideoRequest req) throws Exception {
    if (req.sizeBytes() != null && req.sizeBytes() > app.maxUploadBytes()) {
      throw new IllegalArgumentException("Video exceeds maximum allowed size");
    }
    UUID id = UUID.randomUUID();
    String key = "originals/" + id + "/source";
    Instant now = Instant.now();
    Video v =
        new Video(
            id,
            req.title(),
            req.originalFilename(),
            req.contentType(),
            req.sizeBytes(),
            VideoStatus.CREATED,
            key,
            req.uploaderId(),
            now,
            now);
    repo.save(v);
    String uploadUrl = storage.presignedPut(key, app.presignTtlSeconds());
    return new CreateVideoResponse(
        id,
        uploadUrl,
        "PUT",
        key,
        app.presignTtlSeconds());
  }

  @Transactional
  public void completeUpload(UUID id) throws Exception {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.CREATED) {
      throw new IllegalStateException("Invalid status for complete: " + v.getStatus());
    }
    storage.ensureObjectPresent(v.getOriginalObjectKey());
    v.setStatus(VideoStatus.UPLOADED);
    v.setUpdatedAt(Instant.now());
  }

  @Transactional(readOnly = true)
  public VideoDto get(UUID id) {
    return VideoDto.from(
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found")),
        app.playbackBaseUrl(),
        storage);
  }

  /**
   * Lista todos los videos: primero los {@link VideoStatus#READY}, luego el resto, ordenados por
   * {@code createdAt} dentro de cada grupo.
   */
  @Transactional(readOnly = true)
  public List<VideoDto> list() {
    return repo.findAll().stream()
        .sorted(
            Comparator.comparingInt(
                    (Video v) -> v.getStatus() == VideoStatus.READY ? 0 : 1)
                .thenComparing(Video::getCreatedAt))
        .map(v -> VideoDto.from(v, app.playbackBaseUrl(), storage))
        .toList();
  }

  /**
   * Toma el siguiente video en {@link VideoStatus#UPLOADED} con bloqueo pesimista, o re-adquiere un
   * {@link VideoStatus#PROCESSING} cuyo lease ya venció (worker muerto). En ambos casos renueva el
   * lease hasta {@code app.transcode.leaseTtlSeconds}.
   */
  @Transactional
  public Optional<Video> claimNextForTranscode() {
    Instant leaseUntil = Instant.now().plusSeconds(app.transcode().leaseTtlSeconds());
    Optional<Video> fromUpload =
        repo
            .findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED)
            .map(
                v -> {
                  v.setStatus(VideoStatus.PROCESSING);
                  v.setProcessingProgress(5);
                  v.setProcessingLeaseUntil(leaseUntil);
                  v.setUpdatedAt(Instant.now());
                  return repo.save(v);
                });
    if (fromUpload.isPresent()) {
      return fromUpload;
    }
    return repo
        .findStaleProcessing(VideoStatus.PROCESSING, Instant.now(), PageRequest.of(0, 1))
        .stream()
        .findFirst()
        .map(
            v -> {
              v.setProcessingLeaseUntil(leaseUntil);
              v.setUpdatedAt(Instant.now());
              return repo.save(v);
            });
  }

  /**
   * Extiende {@code processingLeaseUntil} mientras siga en {@code PROCESSING}; no hace nada en
   * otros estados (p. ej. ya marcado READY por otro hilo).
   */
  @Transactional
  public void extendProcessingLease(UUID id) {
    Instant now = Instant.now();
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.PROCESSING) {
      return;
    }
    v.setProcessingLeaseUntil(now.plusSeconds(app.transcode().leaseTtlSeconds()));
    v.setUpdatedAt(now);
    repo.save(v);
  }

  /**
   * Called when the thumbnail is uploaded to storage so clients can show it while HLS is still
   * encoding. Only valid in {@link VideoStatus#PROCESSING}; {@link #markAsReady} sets the same
   * prefix again at completion.
   */
  /**
   * Actualiza el avance de transcodificación (0–100). Solo tiene efecto en {@link
   * VideoStatus#PROCESSING}.
   */
  @Transactional
  public void setTranscodeProgress(UUID id, int percent) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.PROCESSING) {
      return;
    }
    int p = Math.clamp(percent, 0, 100);
    v.setProcessingProgress(p);
    v.setUpdatedAt(Instant.now());
    repo.save(v);
  }

  @Transactional
  public void setTranscodeOutputPrefix(UUID id, String outputPrefix) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.PROCESSING) {
      throw new IllegalStateException("Expected PROCESSING, got " + v.getStatus());
    }
    if (outputPrefix == null || outputPrefix.isBlank()) {
      throw new IllegalArgumentException("outputPrefix required");
    }
    String normalized =
        outputPrefix.endsWith("/") ? outputPrefix : outputPrefix + "/";
    v.setOutputPrefix(normalized);
    v.setUpdatedAt(Instant.now());
  }

  /**
   * Marca el video listo para reproducción, fija prefijo de salida y clave del manifest HLS, y
   * limpia el lease.
   */
  @Transactional
  public void markAsReady(UUID id, String outputPrefix, String manifestObjectKey) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    v.setOutputPrefix(outputPrefix);
    v.setManifestObjectKey(manifestObjectKey);
    v.setStatus(VideoStatus.READY);
    v.setProcessingLeaseUntil(null);
    v.setProcessingProgress(null);
    v.setUpdatedAt(Instant.now());
  }

  /** Persiste fallo de transcodificación, truncando el mensaje a 4000 caracteres. */
  @Transactional
  public void markFailed(UUID id, String errorMessage) {
    Optional<Video> existing = repo.findById(id);
    if (existing.isEmpty()) {
      log.warn("markFailed omitido: video {} ya no existe (p. ej. borrado durante transcodificación)", id);
      return;
    }
    Video v = existing.get();
    v.setStatus(VideoStatus.FAILED);
    v.setProcessingLeaseUntil(null);
    v.setProcessingProgress(null);
    String msg = errorMessage == null ? "Unknown error" : errorMessage;
    v.setErrorMessage(msg.length() > 4000 ? msg.substring(0, 4000) : msg);
    v.setUpdatedAt(Instant.now());
  }

  @Transactional
  public void delete(UUID id, String uploaderId) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (uploaderId == null || !uploaderId.equals(v.getUploaderId())) {
      throw new SecurityException("No tienes permiso para eliminar este video.");
    }
    repo.delete(v);
  }
}
