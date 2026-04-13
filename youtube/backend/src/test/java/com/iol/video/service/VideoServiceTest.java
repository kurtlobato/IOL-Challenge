package com.iol.video.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
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
import com.iol.video.web.dto.PresignedDownloadResponse;
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
  @Mock private CreatedVideoCleanup createdCleanup;

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
            List.of(new AppProperties.HlsVariant("480p", 480, 1_000_000)),
            null);
    videoService = new VideoService(repo, storage, app, createdCleanup);
    lenient()
        .when(storage.publicUrlForKey(any(), any()))
        .thenAnswer(inv -> inv.getArgument(0));
  }

  @Test
  void list_returnsOnlyReadyNewestFirst() {
    Instant t0 = Instant.parse("2020-01-01T00:00:00Z");
    Instant t1 = Instant.parse("2020-01-02T00:00:00Z");
    UUID idReadyOld = UUID.fromString("00000000-0000-0000-0000-000000000002");
    UUID idReadyNew = UUID.fromString("00000000-0000-0000-0000-000000000003");
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
    when(repo.findByStatusOrderByCreatedAtDesc(VideoStatus.READY))
        .thenReturn(List.of(readyNew, readyOld));

    List<UUID> ids = videoService.list().stream().map(d -> d.id()).toList();
    assertEquals(List.of(idReadyNew, idReadyOld), ids);
  }

  @Test
  void create_rejectsWhenOverMaxSize() {
    CreateVideoRequest req =
        new CreateVideoRequest("t", "a.mp4", "video/mp4", app.maxUploadBytes() + 1, "user1", null);
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
    verify(createdCleanup).deleteIfCreated(id);
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
    verify(createdCleanup, never()).deleteIfCreated(any());
  }

  @Test
  void completeUpload_noOpWhenAlreadyUploaded() throws Exception {
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
    when(repo.findById(id)).thenReturn(Optional.of(v));
    videoService.completeUpload(id);
    verify(storage, never()).ensureObjectPresent(any());
    verify(createdCleanup, never()).deleteIfCreated(any());
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
    verify(createdCleanup, never()).deleteIfCreated(any());
  }

  @Test
  void create_idempotencyKeyRequiresUploader() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            videoService.create(
                new CreateVideoRequest("t", "a.mp4", "video/mp4", 100L, "", "idem")));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            videoService.create(
                new CreateVideoRequest("t", "a.mp4", "video/mp4", 100L, null, "idem")));
  }

  @Test
  void create_reusesCreatedRowForSameIdempotencyKey() throws Exception {
    UUID id = UUID.randomUUID();
    Video v =
        new Video(
            id,
            "old",
            "old.mp4",
            "video/mp4",
            1L,
            VideoStatus.CREATED,
            "originals/" + id + "/source",
            "u1",
            Instant.now(),
            Instant.now());
    v.setUploadIdempotencyKey("idem-1");
    when(repo.findByUploaderIdAndUploadIdempotencyKey("u1", "idem-1")).thenReturn(Optional.of(v));
    when(storage.presignedPut(eq(v.getOriginalObjectKey()), anyInt())).thenReturn("http://presign");
    CreateVideoRequest req =
        new CreateVideoRequest("new title", "b.mp4", "video/webm", 99L, "u1", "idem-1");
    var res = videoService.create(req);
    assertEquals(id, res.id());
    assertEquals("http://presign", res.uploadUrl());
    assertEquals("new title", v.getTitle());
    assertEquals("b.mp4", v.getOriginalFilename());
    verify(repo).save(v);
  }

  @Test
  void create_rejectsIdempotencyKeyWhenAlreadyPastCreated() {
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
            "u1",
            Instant.now(),
            Instant.now());
    v.setUploadIdempotencyKey("idem-1");
    when(repo.findByUploaderIdAndUploadIdempotencyKey("u1", "idem-1")).thenReturn(Optional.of(v));
    CreateVideoRequest req =
        new CreateVideoRequest("t", "a.mp4", "video/mp4", 100L, "u1", "idem-1");
    assertThrows(IllegalStateException.class, () -> videoService.create(req));
  }

  @Test
  void requireProcessingForTranscode_returnsVideoWhenProcessing() {
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
    assertEquals(v, videoService.requireProcessingForTranscode(id));
  }

  @Test
  void requireProcessingForTranscode_throwsWhenMissing() {
    UUID id = UUID.randomUUID();
    when(repo.findById(id)).thenReturn(Optional.empty());
    assertThrows(IllegalArgumentException.class, () -> videoService.requireProcessingForTranscode(id));
  }

  @Test
  void requireProcessingForTranscode_throwsWhenNotProcessing() {
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
    when(repo.findById(id)).thenReturn(Optional.of(v));
    assertThrows(
        IllegalStateException.class, () -> videoService.requireProcessingForTranscode(id));
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

  @Test
  void markFailed_noOpWhenVideoMissing() {
    UUID id = UUID.randomUUID();
    when(repo.findById(id)).thenReturn(Optional.empty());
    videoService.markFailed(id, "x");
    verify(repo).findById(id);
  }

  @Test
  void markFailed_setsFailedWhenPresent() {
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
    videoService.markFailed(id, "ffmpeg died");
    assertEquals(VideoStatus.FAILED, v.getStatus());
    assertEquals("ffmpeg died", v.getErrorMessage());
  }

  @Test
  void purgeStaleCreated_removesMatchingRowsAndOriginalKey() {
    Instant cutoff = Instant.parse("2024-01-02T00:00:00Z");
    UUID id = UUID.randomUUID();
    Video old =
        new Video(
            id,
            "t",
            "a.mp4",
            "video/mp4",
            10L,
            VideoStatus.CREATED,
            "originals/" + id + "/source",
            "user1",
            Instant.parse("2024-01-01T00:00:00Z"),
            Instant.parse("2024-01-01T00:00:00Z"));
    when(repo.findByStatusAndCreatedAtBefore(VideoStatus.CREATED, cutoff)).thenReturn(List.of(old));
    assertEquals(1, videoService.purgeStaleCreated(cutoff));
    verify(storage).removeObjectBestEffort("originals/" + id + "/source");
    verify(repo).delete(old);
  }

  @Test
  void purgeStaleCreated_noRowsDoesNothing() {
    when(repo.findByStatusAndCreatedAtBefore(eq(VideoStatus.CREATED), any(Instant.class)))
        .thenReturn(List.of());
    assertEquals(0, videoService.purgeStaleCreated(Instant.now()));
    verify(repo, never()).delete(any());
    verify(storage, never()).removeObjectBestEffort(any());
  }

  @Test
  void recordView_incrementsWhenEligible() {
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
    v.setManifestObjectKey("k/master.m3u8");
    v.setDurationSeconds(100.0);
    v.setViewCount(5L);
    when(repo.findById(id)).thenReturn(Optional.of(v));
    when(repo.registerUniqueView(id, "viewer-a")).thenAnswer(inv -> {
      v.setViewCount(6L);
      return 1;
    });
    assertEquals(6L, videoService.recordView(id, "viewer-a", 10.0));
    verify(repo).registerUniqueView(id, "viewer-a");
  }

  @Test
  void recordView_rejectsBelowTenPercent() {
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
    v.setDurationSeconds(200.0);
    when(repo.findById(id)).thenReturn(Optional.of(v));
    assertThrows(
        IllegalArgumentException.class, () -> videoService.recordView(id, "x", 19.0));
    verify(repo, never()).registerUniqueView(any(), any());
  }

  @Test
  void recordView_rejectsWithoutDuration() {
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
    assertThrows(IllegalStateException.class, () -> videoService.recordView(id, "x", 999.0));
    verify(repo, never()).registerUniqueView(any(), any());
  }

  @Test
  void presignOriginalDownload_ready_allowsNonUploader() throws Exception {
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
            "owner",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    when(storage.presignedGet(eq("originals/" + id + "/source"), anyInt()))
        .thenReturn("https://minio/get");
    PresignedDownloadResponse r = videoService.presignOriginalDownload(id, "other-user");
    assertEquals("https://minio/get", r.url());
    assertEquals("a.mp4", r.filename());
  }

  @Test
  void presignOriginalDownload_processing_requiresUploader() throws Exception {
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
            "owner",
            Instant.now(),
            Instant.now());
    when(repo.findById(id)).thenReturn(Optional.of(v));
    assertThrows(
        SecurityException.class, () -> videoService.presignOriginalDownload(id, "intruder"));
  }
}
