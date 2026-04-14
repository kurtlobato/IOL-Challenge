package com.iol.video.service;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.repo.VideoRepository;
import com.iol.video.storage.ObjectStorageService;
import com.iol.video.web.dto.CreateVideoRequest;
import com.iol.video.web.dto.CreateVideoResponse;
import com.iol.video.web.dto.PresignedDownloadResponse;
import com.iol.video.web.dto.VideoDto;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
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
  private final CreatedVideoCleanup createdCleanup;

  public VideoService(
      VideoRepository repo,
      ObjectStorageService storage,
      AppProperties app,
      CreatedVideoCleanup createdCleanup) {
    this.repo = repo;
    this.storage = storage;
    this.app = app;
    this.createdCleanup = createdCleanup;
  }

  @Transactional
  public CreateVideoResponse create(CreateVideoRequest req) throws Exception {
    if (req.sizeBytes() != null && req.sizeBytes() > app.maxUploadBytes()) {
      throw new IllegalArgumentException("Video exceeds maximum allowed size");
    }
    String idemKey = normalizeUploadIdempotencyKey(req.uploadIdempotencyKey());
    if (idemKey != null) {
      if (req.uploaderId() == null || req.uploaderId().isBlank()) {
        throw new IllegalArgumentException("uploaderId required when uploadIdempotencyKey is set");
      }
      Optional<Video> existing = repo.findByUploaderIdAndUploadIdempotencyKey(req.uploaderId(), idemKey);
      if (existing.isPresent()) {
        return responseForExistingIdempotentCreate(existing.get(), req);
      }
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
    v.setUploadIdempotencyKey(idemKey);
    try {
      repo.save(v);
    } catch (DataIntegrityViolationException e) {
      if (idemKey == null) {
        throw e;
      }
      Optional<Video> raced =
          repo.findByUploaderIdAndUploadIdempotencyKey(req.uploaderId(), idemKey);
      if (raced.isPresent()) {
        return responseForExistingIdempotentCreate(raced.get(), req);
      }
      throw e;
    }
    log.info(
        "Alta video (CREATED, pendiente PUT al bucket): id={} uploaderId={} título=\"{}\" filename={} contentType={} sizeBytes={}",
        id,
        req.uploaderId(),
        abbrev(req.title(), 120),
        abbrev(req.originalFilename(), 120),
        req.contentType(),
        req.sizeBytes());
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
    if (v.getStatus() == VideoStatus.UPLOADED) {
      return;
    }
    if (v.getStatus() != VideoStatus.CREATED) {
      throw new IllegalStateException("Invalid status for complete: " + v.getStatus());
    }
    try {
      storage.ensureObjectPresent(v.getOriginalObjectKey());
    } catch (IllegalStateException e) {
      if ("Original object not found in storage".equals(e.getMessage())) {
        createdCleanup.deleteIfCreated(id);
      }
      throw e;
    }
    v.setStatus(VideoStatus.UPLOADED);
    v.setUpdatedAt(Instant.now());
    log.info(
        "Upload original verificado → UPLOADED: id={} key={} uploaderId={} título=\"{}\"",
        id,
        v.getOriginalObjectKey(),
        v.getUploaderId(),
        abbrev(v.getTitle(), 120));
  }

  @Transactional(readOnly = true)
  public VideoDto get(UUID id) {
    return VideoDto.from(
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found")),
        app.playbackBaseUrl(),
        storage);
  }

  /**
   * Persiste la duración detectada en transcodificación (segundos). Ignora valores no finitos o
   * no positivos.
   */
  @Transactional
  public void setDurationSeconds(UUID id, double seconds) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (Double.isFinite(seconds) && seconds > 0) {
      v.setDurationSeconds(seconds);
      v.setUpdatedAt(Instant.now());
    }
  }

  /**
   * Cuenta una visualización por {@code viewerKey} si el tiempo visto alcanza al menos el 10 %
   * de la duración conocida del video. Requiere {@link VideoStatus#READY} y duración persistida.
   *
   * @return contador de vistas tras la operación (sin incrementar si el viewer ya contó)
   */
  @Transactional
  public long recordView(UUID id, String viewerKey, double watchedSeconds) {
    if (viewerKey == null || viewerKey.isBlank()) {
      throw new IllegalArgumentException("viewerKey required");
    }
    String key = viewerKey.trim();
    if (key.length() > 128) {
      throw new IllegalArgumentException("viewerKey too long");
    }
    if (!Double.isFinite(watchedSeconds) || watchedSeconds < 0) {
      throw new IllegalArgumentException("watchedSeconds invalid");
    }
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.READY) {
      throw new IllegalStateException("Video is not ready for playback");
    }
    Double dur = v.getDurationSeconds();
    if (dur == null || dur <= 0 || !Double.isFinite(dur)) {
      throw new IllegalStateException("Duration not available yet");
    }
    double minWatch = dur * 0.1;
    if (watchedSeconds + 1e-6 < minWatch) {
      throw new IllegalArgumentException("Must watch at least 10% of the video");
    }
    repo.registerUniqueView(id, key);
    return repo.findById(id).orElseThrow().getViewCount();
  }

  /**
   * Lista de videos: por defecto incluye todos los estados (grilla principal). Con {@code
   * readyOnly=true} solo {@link VideoStatus#READY} (p. ej. columna “siguientes videos” en detalle).
   */
  @Transactional(readOnly = true)
  public List<VideoDto> list(Boolean readyOnly) {
    List<Video> rows =
        Boolean.TRUE.equals(readyOnly)
            ? repo.findByStatusOrderByCreatedAtDesc(VideoStatus.READY)
            : repo.findAllByOrderByCreatedAtDesc();
    return rows.stream()
        .map(v -> VideoDto.from(v, app.playbackBaseUrl(), storage))
        .toList();
  }

  /**
   * Toma el siguiente video en {@link VideoStatus#UPLOADED} con bloqueo pesimista, o re-adquiere un
   * {@link VideoStatus#PROCESSING} cuyo lease ya venció (worker muerto). En ambos casos renueva el
   * lease hasta {@code app.transcode.leaseTtlSeconds}.
   */
  /**
   * Metadatos del video para el pipeline de transcodificación: debe existir y estar en {@link
   * VideoStatus#PROCESSING}.
   */
  @Transactional(readOnly = true)
  public Video requireProcessingForTranscode(UUID id) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.PROCESSING) {
      throw new IllegalStateException("Expected PROCESSING, got " + v.getStatus());
    }
    return v;
  }

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
      Video v = fromUpload.get();
      log.info(
          "Cola transcode: reclamado desde UPLOADED → PROCESSING id={} título=\"{}\"",
          v.getId(),
          abbrev(v.getTitle(), 120));
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
              Video saved = repo.save(v);
              log.info(
                  "Cola transcode: reclamado PROCESSING con lease vencido (reintento worker) id={} título=\"{}\"",
                  saved.getId(),
                  abbrev(saved.getTitle(), 120));
              return saved;
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
    log.info(
        "Transcode OK → READY: id={} manifestKey={} título=\"{}\"",
        id,
        manifestObjectKey,
        abbrev(v.getTitle(), 120));
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
    log.warn(
        "Transcode → FAILED: id={} título=\"{}\" error={}",
        id,
        abbrev(v.getTitle(), 120),
        abbrev(msg, 500));
  }

  @Transactional
  public void delete(UUID id, String uploaderId) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (uploaderId == null || !uploaderId.equals(v.getUploaderId())) {
      throw new SecurityException("No tienes permiso para eliminar este video.");
    }
    log.info(
        "Borrado por usuario: id={} uploaderId={} estado={} título=\"{}\"",
        id,
        uploaderId,
        v.getStatus(),
        abbrev(v.getTitle(), 120));
    repo.delete(v);
  }

  @Transactional
  public VideoDto updateTitle(UUID id, String uploaderId, String title) {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (uploaderId == null || uploaderId.isBlank()) {
      throw new IllegalArgumentException("uploaderId required");
    }
    if (!uploaderId.equals(v.getUploaderId())) {
      throw new SecurityException("No tienes permiso para editar este video.");
    }
    String t = title == null ? "" : title.trim();
    if (t.isEmpty()) {
      throw new IllegalArgumentException("title required");
    }
    if (t.length() > 512) {
      throw new IllegalArgumentException("title too long");
    }
    v.setTitle(t);
    v.setUpdatedAt(Instant.now());
    repo.save(v);
    return VideoDto.from(v, app.playbackBaseUrl(), storage);
  }

  @Transactional(readOnly = true)
  public PresignedDownloadResponse presignOriginalDownload(UUID id, String uploaderId)
      throws Exception {
    Video v = repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() == VideoStatus.CREATED) {
      throw new IllegalStateException("El archivo original aún no está disponible.");
    }
    if (v.getStatus() != VideoStatus.READY) {
      if (uploaderId == null || uploaderId.isBlank()) {
        throw new IllegalArgumentException("uploaderId required");
      }
      if (!uploaderId.equals(v.getUploaderId())) {
        throw new SecurityException("No tienes permiso para descargar este archivo.");
      }
    }
    String url = storage.presignedGet(v.getOriginalObjectKey(), app.presignTtlSeconds());
    return new PresignedDownloadResponse(url, v.getOriginalFilename());
  }

  /**
   * Borra vídeos en {@link VideoStatus#CREATED} con {@code createdAt} anterior al umbral; intenta
   * quitar el original en almacenamiento antes de borrar la fila.
   *
   * @return cantidad de filas eliminadas
   */
  @Transactional
  public int purgeStaleCreated(Instant createdBefore) {
    List<Video> stale =
        repo.findByStatusAndCreatedAtBefore(VideoStatus.CREATED, createdBefore);
    for (Video v : stale) {
      storage.removeObjectBestEffort(v.getOriginalObjectKey());
      repo.delete(v);
    }
    if (!stale.isEmpty()) {
      log.info("purgeStaleCreated: removed {} CREATED videos older than {}", stale.size(), createdBefore);
    }
    return stale.size();
  }

  private static String abbrev(String s, int max) {
    if (s == null) {
      return "";
    }
    String t = s.replace('\n', ' ').trim();
    return t.length() <= max ? t : t.substring(0, max) + "…";
  }

  private static String normalizeUploadIdempotencyKey(String raw) {
    if (raw == null) {
      return null;
    }
    String t = raw.trim();
    return t.isEmpty() ? null : t;
  }

  private CreateVideoResponse responseForExistingIdempotentCreate(Video ex, CreateVideoRequest req)
      throws Exception {
    if (ex.getStatus() == VideoStatus.CREATED) {
      applyCreateMetadata(ex, req);
      ex.setUpdatedAt(Instant.now());
      repo.save(ex);
      log.info(
          "Alta idempotente (mismo CREATED): id={} uploadIdempotencyKey={} uploaderId={}",
          ex.getId(),
          abbrev(ex.getUploadIdempotencyKey(), 64),
          ex.getUploaderId());
      String uploadUrl = storage.presignedPut(ex.getOriginalObjectKey(), app.presignTtlSeconds());
      return new CreateVideoResponse(
          ex.getId(),
          uploadUrl,
          "PUT",
          ex.getOriginalObjectKey(),
          app.presignTtlSeconds());
    }
    throw new IllegalStateException(
        "Upload already registered for this idempotency key (status: " + ex.getStatus() + ")");
  }

  private static void applyCreateMetadata(Video v, CreateVideoRequest req) {
    v.setTitle(req.title());
    v.setOriginalFilename(req.originalFilename());
    v.setContentType(req.contentType());
    v.setSizeBytes(req.sizeBytes());
  }
}
