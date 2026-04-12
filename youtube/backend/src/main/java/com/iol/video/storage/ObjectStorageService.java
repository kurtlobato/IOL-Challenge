package com.iol.video.storage;

import com.iol.video.config.MinioProperties;
import io.minio.GetObjectArgs;
import io.minio.GetPresignedObjectUrlArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import io.minio.StatObjectArgs;
import io.minio.http.Method;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;

@Service
public class ObjectStorageService {

  private final MinioClient client;
  private final MinioProperties props;

  public ObjectStorageService(MinioClient client, MinioProperties props) {
    this.client = client;
    this.props = props;
  }

  public String presignedPut(String objectKey, int ttlSeconds) throws Exception {
    var builder =
        GetPresignedObjectUrlArgs.builder()
            .method(Method.PUT)
            .bucket(props.bucket())
            .object(objectKey)
            .expiry(ttlSeconds, TimeUnit.SECONDS);
    return client.getPresignedObjectUrl(builder.build());
  }

  public boolean objectExists(String objectKey) {
    try {
      client.statObject(
          StatObjectArgs.builder().bucket(props.bucket()).object(objectKey).build());
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  public void uploadFile(String objectKey, Path file, String contentType) throws Exception {
    long size = Files.size(file);
    try (InputStream in = Files.newInputStream(file)) {
      client.putObject(
          PutObjectArgs.builder()
              .bucket(props.bucket())
              .object(objectKey)
              .stream(in, size, -1)
              .contentType(contentType != null ? contentType : "application/octet-stream")
              .build());
    }
  }

  public void uploadStream(String objectKey, InputStream in, long size, String contentType)
      throws Exception {
    client.putObject(
        PutObjectArgs.builder()
            .bucket(props.bucket())
            .object(objectKey)
            .stream(in, size, -1)
            .contentType(contentType != null ? contentType : "application/octet-stream")
            .build());
  }

  public InputStream getObject(String objectKey) throws Exception {
    return client.getObject(
        GetObjectArgs.builder().bucket(props.bucket()).object(objectKey).build());
  }

  public String bucket() {
    return props.bucket();
  }

  public String publicUrlForKey(String objectKey, String playbackBaseUrl) {
    String base = playbackBaseUrl.endsWith("/") ? playbackBaseUrl.substring(0, playbackBaseUrl.length() - 1) : playbackBaseUrl;
    return base + "/" + props.bucket() + "/" + objectKey;
  }
}
