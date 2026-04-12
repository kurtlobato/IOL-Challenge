package com.iol.video.config;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ResilienceConfig {

  @Bean(destroyMethod = "shutdown")
  ScheduledExecutorService minioResilienceScheduler() {
    return Executors.newScheduledThreadPool(
        2,
        r -> {
          Thread t = new Thread(r, "minio-resilience");
          t.setDaemon(true);
          return t;
        });
  }
}
