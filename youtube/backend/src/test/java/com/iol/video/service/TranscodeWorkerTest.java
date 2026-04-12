package com.iol.video.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.iol.video.config.AppProperties;
import com.iol.video.domain.Video;
import com.iol.video.domain.VideoStatus;
import java.time.Instant;
import java.util.List;
import net.javacrumbs.shedlock.core.LockConfiguration;
import net.javacrumbs.shedlock.core.LockingTaskExecutor;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.env.Environment;

@ExtendWith(MockitoExtension.class)
class TranscodeWorkerTest {

  @Mock private VideoService videoService;
  @Mock private TranscodeService transcodeService;
  @Mock private Environment env;

  private TranscodeWorker worker;

  private static final LockingTaskExecutor NOOP_LOCK =
      new LockingTaskExecutor() {
        @Override
        public void executeWithLock(Runnable task, LockConfiguration lockConfiguration) {
          task.run();
        }

        @Override
        public void executeWithLock(Task task, LockConfiguration lockConfiguration)
            throws Throwable {
          task.call();
        }
      };

  @BeforeEach
  void init() {
    AppProperties app =
        new AppProperties(
            1000L,
            900,
            "http://localhost/storage",
            new AppProperties.Transcode(3, 4000L, 120, 45, 45, 7200, 180),
            new AppProperties.Ffmpeg("ffmpeg"),
            List.of(new AppProperties.HlsVariant("480p", 480, 1_000_000)));
    worker = new TranscodeWorker(videoService, transcodeService, env, NOOP_LOCK, app);
    lenient().when(env.getProperty("app.transcode.max-retries", Integer.class, 3)).thenReturn(3);
  }

  @Test
  void poll_skipsWhenNothingToProcess() throws Exception {
    when(videoService.claimNextForTranscode()).thenReturn(Optional.empty());
    worker.poll();
    verify(transcodeService, never()).runPipeline(any());
    verify(videoService, never()).markFailed(any(), any());
  }

  @Test
  void poll_onSuccess_doesNotMarkFailed() throws Exception {
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
    when(videoService.claimNextForTranscode()).thenReturn(Optional.of(v));
    doNothing().when(transcodeService).runPipeline(id);

    worker.poll();

    verify(transcodeService).runPipeline(id);
    verify(videoService, never()).markFailed(any(), any());
  }

  @Test
  void poll_onPersistentFailure_marksFailed() throws Exception {
    when(env.getProperty("app.transcode.max-retries", Integer.class, 3)).thenReturn(1);
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
    when(videoService.claimNextForTranscode()).thenReturn(Optional.of(v));
    doThrow(new RuntimeException("ffmpeg")).when(transcodeService).runPipeline(id);

    worker.poll();

    verify(transcodeService, times(1)).runPipeline(id);
    verify(videoService).markFailed(eq(id), any());
  }
}
