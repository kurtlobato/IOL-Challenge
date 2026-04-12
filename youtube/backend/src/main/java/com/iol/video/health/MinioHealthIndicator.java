package com.iol.video.health;

import com.iol.video.config.MinioProperties;
import io.minio.BucketExistsArgs;
import io.minio.MinioClient;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "management.health.minio.enabled", havingValue = "true", matchIfMissing = true)
public class MinioHealthIndicator implements HealthIndicator {

  private final MinioClient client;
  private final MinioProperties props;

  public MinioHealthIndicator(MinioClient client, MinioProperties props) {
    this.client = client;
    this.props = props;
  }

  @Override
  public Health health() {
    try {
      boolean ok =
          client.bucketExists(BucketExistsArgs.builder().bucket(props.bucket()).build());
      if (ok) {
        return Health.up().withDetail("bucket", props.bucket()).build();
      }
      return Health.down().withDetail("bucket", props.bucket()).withDetail("reason", "missing").build();
    } catch (Exception e) {
      return Health.down(e).withDetail("bucket", props.bucket()).build();
    }
  }
}
