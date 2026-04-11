package com.iol.video.web;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.iol.video.service.VideoService;
import com.iol.video.web.dto.CreateVideoResponse;
import com.iol.video.web.dto.VideoDto;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(VideoController.class)
class VideoControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private VideoService videoService;

  @Test
  void createReturns201() throws Exception {
    UUID id = UUID.randomUUID();
    when(videoService.create(any()))
        .thenReturn(
            new CreateVideoResponse(
                id, "http://minio/presign", "PUT", "originals/" + id + "/source", 900));
    mockMvc
        .perform(
            post("/api/videos")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    """
                    {"title":"t","originalFilename":"a.mp4","contentType":"video/mp4","sizeBytes":1024}
                    """))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.id").value(id.toString()))
        .andExpect(jsonPath("$.uploadUrl").value("http://minio/presign"));
  }

  @Test
  void listReturnsVideos() throws Exception {
    UUID id = UUID.randomUUID();
    when(videoService.list())
        .thenReturn(
            List.of(
                new VideoDto(
                    id,
                    "hello",
                    "READY",
                    "http://x/m.m3u8",
                    null,
                    Instant.parse("2025-01-01T00:00:00Z"))));
    mockMvc
        .perform(get("/api/videos"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$[0].title").value("hello"))
        .andExpect(jsonPath("$[0].status").value("READY"));
  }
}
