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
import java.util.List;
import java.util.Optional;
import java.util.UUID;
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
        .sorted((a, b) -> b.getCreatedAt().compareTo(a.getCreatedAt()))
        .map(v -> VideoDto.from(v, app.playbackBaseUrl(), storage))
        .toList();
  }

  @Transactional
  public Optional<Video> claimNextForTranscode() {
    return repo
        .findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED)
        .map(
            v -> {
              v.setStatus(VideoStatus.PROCESSING);
              v.setUpdatedAt(Instant.now());
              return repo.save(v);
            });
  }

  @Transactional
  public void markAsReady(UUID id, String outputPrefix, String manifestObjectKey) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    v.setOutputPrefix(outputPrefix);
    v.setManifestObjectKey(manifestObjectKey);
    v.setStatus(VideoStatus.READY);
    v.setUpdatedAt(Instant.now());
  }

  @Transactional
  public void markFailed(UUID id, String errorMessage) {
    Video v =
        repo.findById(id).orElseThrow(() -> new IllegalArgumentException("Video not found"));
    v.setStatus(VideoStatus.FAILED);
    String msg = errorMessage == null ? "Unknown error" : errorMessage;
    v.setErrorMessage(msg.length() > 4000 ? msg.substring(0, 4000) : msg);
    v.setUpdatedAt(Instant.now());
  }
}
