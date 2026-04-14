package com.iol.video.web;

import com.iol.video.service.VideoService;
import com.iol.video.web.dto.CreateVideoRequest;
import com.iol.video.web.dto.CreateVideoResponse;
import com.iol.video.web.dto.PresignedDownloadResponse;
import com.iol.video.web.dto.RegisterViewRequest;
import com.iol.video.web.dto.UpdateVideoRequest;
import com.iol.video.web.dto.VideoDto;
import com.iol.video.web.dto.ViewCountResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/videos")
public class VideoController {

  private final VideoService videoService;

  public VideoController(VideoService videoService) {
    this.videoService = videoService;
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public CreateVideoResponse create(@Valid @RequestBody CreateVideoRequest body) throws Exception {
    return videoService.create(body);
  }

  @PostMapping("/{id}/complete")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void complete(@PathVariable UUID id) throws Exception {
    videoService.completeUpload(id);
  }

  @GetMapping("/{id}")
  public VideoDto get(@PathVariable UUID id) {
    return videoService.get(id);
  }

  @PostMapping("/{id}/views")
  public ViewCountResponse registerView(
      @PathVariable UUID id, @Valid @RequestBody RegisterViewRequest body) {
    long count = videoService.recordView(id, body.viewerKey(), body.watchedSeconds());
    return new ViewCountResponse(count);
  }

  @GetMapping
  public List<VideoDto> list(@RequestParam(required = false) Boolean readyOnly) {
    return videoService.list(readyOnly);
  }

  @DeleteMapping("/{id}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void delete(@PathVariable UUID id, @RequestParam(required = false) String uploaderId) {
    videoService.delete(id, uploaderId);
  }

  @PatchMapping("/{id}")
  public VideoDto patchTitle(
      @PathVariable UUID id,
      @RequestParam String uploaderId,
      @Valid @RequestBody UpdateVideoRequest body) {
    return videoService.updateTitle(id, uploaderId, body.title());
  }

  @GetMapping("/{id}/original-download")
  public PresignedDownloadResponse originalDownload(
      @PathVariable UUID id, @RequestParam(required = false) String uploaderId) throws Exception {
    return videoService.presignOriginalDownload(id, uploaderId);
  }
}
