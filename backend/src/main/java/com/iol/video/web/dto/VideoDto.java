package com.iol.video.web.dto;

import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.storage.ObjectStorageService;
import java.time.Instant;
import java.util.UUID;

public record VideoDto(
    UUID id,
    String title,
    String status,
    String manifestUrl,
    String errorMessage,
    Instant createdAt) {

  public static VideoDto from(Video v, String playbackBaseUrl, ObjectStorageService storage) {
    String manifest = null;
    if (v.getStatus() == VideoStatus.READY && v.getManifestObjectKey() != null) {
      manifest = storage.publicUrlForKey(v.getManifestObjectKey(), playbackBaseUrl);
    }
    return new VideoDto(
        v.getId(),
        v.getTitle(),
        v.getStatus().name(),
        manifest,
        v.getErrorMessage(),
        v.getCreatedAt());
  }
}
