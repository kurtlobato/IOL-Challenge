package com.iol.video.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "videos")
public class Video {

  @Id private UUID id;

  @Column(nullable = false, length = 512)
  private String title;

  @Column(name = "original_filename", nullable = false, length = 512)
  private String originalFilename;

  @Column(name = "content_type", length = 256)
  private String contentType;

  @Column(name = "size_bytes")
  private Long sizeBytes;

  @Enumerated(EnumType.STRING)
  @Column(nullable = false, length = 32)
  private VideoStatus status;

  @Column(name = "original_object_key", nullable = false, length = 1024)
  private String originalObjectKey;

  @Column(name = "output_prefix", length = 1024)
  private String outputPrefix;

  @Column(name = "manifest_object_key", length = 1024)
  private String manifestObjectKey;

  @Column(name = "error_message", columnDefinition = "TEXT")
  private String errorMessage;

  @Column(name = "created_at", nullable = false)
  private Instant createdAt;

  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected Video() {}

  public Video(
      UUID id,
      String title,
      String originalFilename,
      String contentType,
      Long sizeBytes,
      VideoStatus status,
      String originalObjectKey,
      Instant createdAt,
      Instant updatedAt) {
    this.id = id;
    this.title = title;
    this.originalFilename = originalFilename;
    this.contentType = contentType;
    this.sizeBytes = sizeBytes;
    this.status = status;
    this.originalObjectKey = originalObjectKey;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  public UUID getId() {
    return id;
  }

  public String getTitle() {
    return title;
  }

  public String getOriginalFilename() {
    return originalFilename;
  }

  public String getContentType() {
    return contentType;
  }

  public Long getSizeBytes() {
    return sizeBytes;
  }

  public VideoStatus getStatus() {
    return status;
  }

  public void setStatus(VideoStatus status) {
    this.status = status;
  }

  public String getOriginalObjectKey() {
    return originalObjectKey;
  }

  public String getOutputPrefix() {
    return outputPrefix;
  }

  public void setOutputPrefix(String outputPrefix) {
    this.outputPrefix = outputPrefix;
  }

  public String getManifestObjectKey() {
    return manifestObjectKey;
  }

  public void setManifestObjectKey(String manifestObjectKey) {
    this.manifestObjectKey = manifestObjectKey;
  }

  public String getErrorMessage() {
    return errorMessage;
  }

  public void setErrorMessage(String errorMessage) {
    this.errorMessage = errorMessage;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }
}
