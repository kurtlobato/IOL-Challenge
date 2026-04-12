package com.iol.video.config;

import io.minio.BucketExistsArgs;
import io.minio.MakeBucketArgs;
import io.minio.MinioClient;
import io.minio.SetBucketPolicyArgs;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ApplicationListener;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Cliente MinIO con timeouts HTTP y arranque del bucket/política de lectura pública en {@code transcoded/*}. */
@Configuration
@EnableConfigurationProperties({MinioProperties.class, AppProperties.class})
public class MinioConfig {

  private static final Logger log = LoggerFactory.getLogger(MinioConfig.class);

  @Bean
  public MinioClient minioClient(MinioProperties p) {
    MinioProperties.Http h = p.http();
    OkHttpClient http =
        new OkHttpClient.Builder()
            .connectTimeout(h.connectTimeoutMillis(), TimeUnit.MILLISECONDS)
            .readTimeout(h.readTimeoutMillis(), TimeUnit.MILLISECONDS)
            .writeTimeout(h.writeTimeoutMillis(), TimeUnit.MILLISECONDS)
            .build();
    return MinioClient.builder()
        .endpoint(p.endpoint())
        .credentials(p.accessKey(), p.secretKey())
        .region(p.region())
        .httpClient(http)
        .build();
  }

  @Bean
  public MinioBucketInitializer minioBucketInitializer(MinioClient client, MinioProperties p) {
    return new MinioBucketInitializer(client, p);
  }

  /**
   * Tras el contexto listo: asegura bucket, aplica política S3 solo para prefijo {@code transcoded/}
   * (GetObject público) para servir HLS/thumbnail vía CDN o proxy.
   */
  public static final class MinioBucketInitializer implements ApplicationListener<ApplicationReadyEvent> {

    private final MinioClient client;
    private final MinioProperties p;

    MinioBucketInitializer(MinioClient client, MinioProperties p) {
      this.client = client;
      this.p = p;
    }

    @Override
    public void onApplicationEvent(ApplicationReadyEvent event) {
      try {
        boolean exists =
            client.bucketExists(BucketExistsArgs.builder().bucket(p.bucket()).build());
        if (!exists) {
          client.makeBucket(MakeBucketArgs.builder().bucket(p.bucket()).build());
          log.info("Created MinIO bucket {}", p.bucket());
        }
        String policy =
            """
            {
              "Version": "2012-10-17",
              "Statement": [
                {
                  "Effect": "Allow",
                  "Principal": {"AWS": ["*"]},
                  "Action": ["s3:GetObject"],
                  "Resource": ["arn:aws:s3:::%s/transcoded/*"]
                }
              ]
            }
            """
                .formatted(p.bucket());
        client.setBucketPolicy(
            SetBucketPolicyArgs.builder().bucket(p.bucket()).config(policy).build());
        log.info("Set public read policy on {}/transcoded/*", p.bucket());
      } catch (Exception e) {
        log.warn("MinIO bucket init skipped or failed: {}", e.getMessage());
      }
    }
  }
}
