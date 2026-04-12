package com.iol.video.web.dto;

import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.storage.ObjectStorageService;
import java.time.Instant;
import java.util.UUID;

/** Vista API de un video: URLs de manifest/miniatura según estado (READY vs PROCESSING parcial). */
public record VideoDto(
    UUID id,
    String title,
    String status,
    String manifestUrl,
    String thumbnailUrl,
    String errorMessage,
    String uploaderId,
    Instant createdAt,
    Integer progressPercent) {

  /**
   * En READY construye manifest y miniatura a partir de la clave del master (sustituye {@code
   * master.m3u8} por {@code thumbnail.jpg}). En PROCESSING solo expone miniatura si ya hay {@code
   * outputPrefix}.
   */
  public static VideoDto from(Video v, String playbackBaseUrl, ObjectStorageService storage) {
    String manifest = null;
    String thumb = null;
    if (v.getStatus() == VideoStatus.READY && v.getManifestObjectKey() != null) {
      manifest = storage.publicUrlForKey(v.getManifestObjectKey(), playbackBaseUrl);
      String thumbnailKey = v.getManifestObjectKey().replace("master.m3u8", "thumbnail.jpg");
      thumb = storage.publicUrlForKey(thumbnailKey, playbackBaseUrl);
    } else if (v.getStatus() == VideoStatus.PROCESSING && v.getOutputPrefix() != null) {
      thumb =
          storage.publicUrlForKey(v.getOutputPrefix() + "thumbnail.jpg", playbackBaseUrl);
    }
    Integer progressPercent =
        switch (v.getStatus()) {
          case UPLOADED -> 0;
          case PROCESSING ->
              v.getProcessingProgress() != null ? v.getProcessingProgress() : 1;
          default -> null;
        };
    return new VideoDto(
        v.getId(),
        v.getTitle(),
        v.getStatus().name(),
        manifest,
        thumb,
        v.getErrorMessage(),
        v.getUploaderId(),
        v.getCreatedAt(),
        progressPercent);
  }
}
