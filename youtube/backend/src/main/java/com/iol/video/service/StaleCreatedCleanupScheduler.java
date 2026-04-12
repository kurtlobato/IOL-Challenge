package com.iol.video.service;

import com.iol.video.config.AppProperties;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.concurrent.TimeUnit;
import net.javacrumbs.shedlock.core.LockConfiguration;
import net.javacrumbs.shedlock.core.LockingTaskExecutor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Job que elimina vídeos en {@code CREATED} abandonados más allá de {@link
 * AppProperties.StaleCreatedCleanup#maxAgeHours}. Usa ShedLock para una sola réplica por tick.
 */
@Component
public class StaleCreatedCleanupScheduler {

  private static final Logger log = LoggerFactory.getLogger(StaleCreatedCleanupScheduler.class);

  private static final String LOCK_NAME = "stale-created-cleanup";

  private final VideoService videoService;
  private final AppProperties app;
  private final LockingTaskExecutor lockExecutor;

  public StaleCreatedCleanupScheduler(
      VideoService videoService,
      AppProperties app,
      LockingTaskExecutor transcodeClaimLockExecutor) {
    this.videoService = videoService;
    this.app = app;
    this.lockExecutor = transcodeClaimLockExecutor;
  }

  @Scheduled(fixedDelayString = "${app.stale-created-cleanup.poll-ms}", timeUnit = TimeUnit.MILLISECONDS)
  public void purgeAbandonedCreated() {
    AppProperties.StaleCreatedCleanup cfg = app.staleCreatedCleanup();
    long pollMs = cfg.pollMs();
    lockExecutor.executeWithLock(
        (Runnable) this::runPurge,
        new LockConfiguration(
            Instant.now(),
            LOCK_NAME,
            Duration.ofMillis(Math.max(pollMs, 60_000L)),
            Duration.ofMillis(10)));
  }

  private void runPurge() {
    try {
      Instant cutoff =
          Instant.now().minus(app.staleCreatedCleanup().maxAgeHours(), ChronoUnit.HOURS);
      videoService.purgeStaleCreated(cutoff);
    } catch (Exception e) {
      log.warn("Stale CREATED cleanup failed: {}", e.getMessage());
    }
  }
}
