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
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class VideoService {

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
  public void completeUpload(UUID id) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    if (v.getStatus() != VideoStatus.CREATED) {
      throw new IllegalStateException("Invalid status for complete: " + v.getStatus());
    }
    if (!storage.objectExists(v.getOriginalObjectKey())) {
      throw new IllegalStateException("Original object not found in storage");
    }
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

  @Transactional
  public Optional<Video> claimNextForTranscode() {
    Instant leaseUntil = Instant.now().plusSeconds(app.transcode().leaseTtlSeconds());
    Optional<Video> fromUpload =
        repo
            .findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED)
            .map(
                v -> {
                  v.setStatus(VideoStatus.PROCESSING);
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

  @Transactional
  public void markAsReady(UUID id, String outputPrefix, String manifestObjectKey) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    v.setOutputPrefix(outputPrefix);
    v.setManifestObjectKey(manifestObjectKey);
    v.setStatus(VideoStatus.READY);
    v.setProcessingLeaseUntil(null);
    v.setUpdatedAt(Instant.now());
  }

  @Transactional
  public void markFailed(UUID id, String errorMessage) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    v.setStatus(VideoStatus.FAILED);
    v.setProcessingLeaseUntil(null);
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
