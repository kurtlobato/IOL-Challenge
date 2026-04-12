package com.iol.video.web;

import com.iol.video.service.VideoService;
import com.iol.video.web.dto.CreateVideoRequest;
import com.iol.video.web.dto.CreateVideoResponse;
import com.iol.video.web.dto.VideoDto;
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

  @GetMapping
  public List<VideoDto> list() {
    return videoService.list();
  }

  @DeleteMapping("/{id}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void delete(@PathVariable UUID id, @RequestParam(required = false) String uploaderId) {
    videoService.delete(id, uploaderId);
  }
}
