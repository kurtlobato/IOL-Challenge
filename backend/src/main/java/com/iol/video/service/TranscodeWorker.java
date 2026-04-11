package com.iol.video.service;

import com.iol.video.domain.Video;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class TranscodeWorker {

  private static final Logger log = LoggerFactory.getLogger(TranscodeWorker.class);

  private final VideoService videoService;
  private final TranscodeService transcodeService;
  private final org.springframework.core.env.Environment env;

  public TranscodeWorker(
      VideoService videoService,
      TranscodeService transcodeService,
      org.springframework.core.env.Environment env) {
    this.videoService = videoService;
    this.transcodeService = transcodeService;
    this.env = env;
  }

  @Scheduled(fixedDelayString = "${app.transcode.poll-ms}")
  public void poll() {
    Optional<Video> claimed = videoService.claimNextForTranscode();
    if (claimed.isEmpty()) {
      return;
    }
    UUID id = claimed.get().getId();
    int max = env.getProperty("app.transcode.max-retries", Integer.class, 3);
    Exception last = null;
    for (int attempt = 1; attempt <= max; attempt++) {
      try {
        transcodeService.runPipeline(id);
        return;
      } catch (Exception e) {
        last = e;
        log.warn("Transcode attempt {} failed for {}: {}", attempt, id, e.getMessage());
        if (attempt < max) {
          try {
            Thread.sleep(1000L * attempt);
          } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            videoService.markFailed(id, "Interrupted during transcode");
            return;
          }
        }
      }
    }
    if (last != null) {
      log.error("Transcode failed for {}", id, last);
      String msg = last.getMessage() != null ? last.getMessage() : last.getClass().getSimpleName();
      videoService.markFailed(id, msg);
    }
  }
}
