package com.iol.video.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import com.iol.video.repo.VideoRepository;
import com.iol.video.storage.ObjectStorageService;
import com.iol.video.web.dto.CreateVideoRequest;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class VideoServiceTest {

  @Mock private VideoRepository repo;
  @Mock private ObjectStorageService storage;

  private AppProperties app;
  private VideoService videoService;

  @BeforeEach
  void setUp() {
    app =
        new AppProperties(
            1000L,
            900,
            "http://localhost/storage",
            new AppProperties.Transcode(3, 4000L, 120, 45, 45, 7200, 180),
            new AppProperties.Ffmpeg("ffmpeg"),
            List.of(new AppProperties.HlsVariant("480p", 480, 1_000_000)));
    videoService = new VideoService(repo, storage, app);
    lenient()
        .when(storage.publicUrlForKey(any(), any()))
        .thenAnswer(inv -> inv.getArgument(0));
  }

  @Test
  void list_ordersReadyFirstThenByCreatedAtAscending() {
    Instant t0 = Instant.parse("2020-01-01T00:00:00Z");
    Instant t1 = Instant.parse("2020-01-02T00:00:00Z");
    Instant t2 = Instant.parse("2020-01-03T00:00:00Z");
    UUID idProcessing = UUID.fromString("00000000-0000-0000-0000-000000000001");
    UUID idReadyOld = UUID.fromString("00000000-0000-0000-0000-000000000002");
    UUID idReadyNew = UUID.fromString("00000000-0000-0000-0000-000000000003");
    Video processing =
        new Video(
            idProcessing,
            "p",
            "a.mp4",
            "video/mp4",
            1L,
            VideoStatus.PROCESSING,
            "originals/" + idProcessing + "/source",
            "u1",
            t2,
            t2);
    Video readyOld =
        new Video(
            idReadyOld,
            "ro",
            "b.mp4",
            "video/mp4",
            1L,
            VideoStatus.READY,
            "originals/" + idReadyOld + "/source",
            "u1",
            t0,
            t0);
    readyOld.setManifestObjectKey("k/master.m3u8");
    Video readyNew =
        new Video(
            idReadyNew,
            "rn",
            "c.mp4",
            "video/mp4",
            1L,
            VideoStatus.READY,
            "originals/" + idReadyNew + "/source",
            "u1",
            t1,
            t1);
    readyNew.setManifestObjectKey("k2/master.m3u8");
    when(repo.findAll()).thenReturn(List.of(processing, readyNew, readyOld));

    List<UUID> ids = videoService.list().stream().map(d -> d.id()).toList();
    assertEquals(List.of(idReadyOld, idReadyNew, idProcessing), ids);
  }

  @Test
  void create_rejectsWhenOverMaxSize() {
    CreateVideoRequest req =
        new CreateVideoRequest("t", "a.mp4", "video/mp4", app.maxUploadBytes() + 1, "user1");
    assertThrows(IllegalArgumentException.class, () -> videoService.create(req));
    verify(repo, never()).save(any());
  }

  @Test
  void completeUpload_requiresCreatedAndObjectExists() throws Exception {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.CREATED,
            "originals/" + id + "/source",
            "user1",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    doThrow(new IllegalStateException("Original object not found in storage"))
        .when(storage)
        .ensureObjectPresent(v.getOriginalObjectKey());
    assertThrows(IllegalStateException.class, () -> videoService.completeUpload(id));
  }

  @Test
  void completeUpload_setsUploadedWhenObjectPresent() throws Exception {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.CREATED,
            "originals/" + id + "/source",
            "user1",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    doNothing().when(storage).ensureObjectPresent(v.getOriginalObjectKey());
    videoService.completeUpload(id);
    assertEquals(VideoStatus.UPLOADED, v.getStatus());
  }

  @Test
  void completeUpload_rejectsWrongStatus() throws Exception {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.READY,
            "originals/" + id + "/source",
            "user1",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    assertThrows(IllegalStateException.class, () -> videoService.completeUpload(id));
    verify(storage, never()).ensureObjectPresent(any());
  }

  @Test
  void claimNextForTranscode_movesUploadedToProcessing() {
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
            Instant.now(),
            Instant.now());
    when(repo.findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED))
        .thenReturn(Optional.of(v));
    when(repo.save(any())).thenAnswer(inv -> inv.getArgument(0));

    Optional<Video> out = videoService.claimNextForTranscode();
    assertTrue(out.isPresent());
    assertEquals(VideoStatus.PROCESSING, out.get().getStatus());
    assertEquals(5, out.get().getProcessingProgress());
    assertTrue(out.get().getProcessingLeaseUntil().isAfter(Instant.now()));
  }

  @Test
  void claimNextForTranscode_emptyWhenNothingUploaded() {
    when(repo.findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED))
        .thenReturn(Optional.empty());
    when(repo.findStaleProcessing(eq(VideoStatus.PROCESSING), any(), any()))
        .thenReturn(List.of());
    assertTrue(videoService.claimNextForTranscode().isEmpty());
  }

  @Test
  void claimNextForTranscode_refreshesLeaseOnStaleProcessing() {
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
            Instant.now(),
            Instant.now());
    v.setProcessingLeaseUntil(Instant.parse("2000-01-01T00:00:00Z"));
    when(repo.findFirstByStatusOrderByCreatedAtAsc(VideoStatus.UPLOADED))
        .thenReturn(Optional.empty());
    when(repo.findStaleProcessing(eq(VideoStatus.PROCESSING), any(), any()))
        .thenReturn(List.of(v));
    when(repo.save(any())).thenAnswer(inv -> inv.getArgument(0));

    Optional<Video> out = videoService.claimNextForTranscode();
    assertTrue(out.isPresent());
    assertEquals(VideoStatus.PROCESSING, out.get().getStatus());
    assertTrue(out.get().getProcessingLeaseUntil().isAfter(Instant.now()));
  }

  @Test
  void setTranscodeOutputPrefix_setsPrefixWhenProcessing() {
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
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    videoService.setTranscodeOutputPrefix(id, "transcoded/" + id);
    assertEquals("transcoded/" + id + "/", v.getOutputPrefix());
  }

  @Test
  void setTranscodeProgress_updatesWhenProcessing() {
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
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    when(repo.save(any())).thenAnswer(inv -> inv.getArgument(0));
    videoService.setTranscodeProgress(id, 42);
    assertEquals(42, v.getProcessingProgress());
  }

  @Test
  void setTranscodeOutputPrefix_rejectsWhenNotProcessing() {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.READY,
            "originals/" + id + "/source",
            "user1",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    assertThrows(
        IllegalStateException.class,
        () -> videoService.setTranscodeOutputPrefix(id, "transcoded/" + id + "/"));
  }
}
