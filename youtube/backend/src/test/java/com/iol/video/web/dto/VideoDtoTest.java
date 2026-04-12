package com.iol.video.web.dto;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.storage.ObjectStorageService;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class VideoDtoTest {

  @Mock private ObjectStorageService storage;

  @Test
  void from_processingWithOutputPrefix_exposesThumbnailUrlOnly() {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.PROCESSING,
            "originals/" + id + "/source",
            "user1",
            Instant.parse("2025-01-01T00:00:00Z"),
            Instant.parse("2025-01-01T00:00:00Z"));
    v.setOutputPrefix("transcoded/" + id + "/");
    when(storage.publicUrlForKey(eq("transcoded/" + id + "/thumbnail.jpg"), eq("http://pb/")))
        .thenReturn("http://pb/bucket/transcoded/" + id + "/thumbnail.jpg");
    VideoDto dto = VideoDto.from(v, "http://pb/", storage);
    assertNull(dto.manifestUrl());
    assertEquals("http://pb/bucket/transcoded/" + id + "/thumbnail.jpg", dto.thumbnailUrl());
    assertEquals(1, dto.progressPercent());
    assertNull(dto.durationSeconds());
    assertEquals(0L, dto.viewCount());
  }

  @Test
  void from_processingWithoutOutputPrefix_hasNoThumbnail() {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.PROCESSING,
            "originals/" + id + "/source",
            "user1",
            Instant.parse("2025-01-01T00:00:00Z"),
            Instant.parse("2025-01-01T00:00:00Z"));
    VideoDto dto = VideoDto.from(v, "http://pb/", storage);
    assertNull(dto.thumbnailUrl());
    assertEquals(1, dto.progressPercent());
  }

  @Test
  void from_uploaded_showsZeroPercent() {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.UPLOADED,
            "originals/" + id + "/source",
            "user1",
            Instant.parse("2025-01-01T00:00:00Z"),
            Instant.parse("2025-01-01T00:00:00Z"));
    VideoDto dto = VideoDto.from(v, "http://pb/", storage);
    assertEquals(0, dto.progressPercent());
  }
}
