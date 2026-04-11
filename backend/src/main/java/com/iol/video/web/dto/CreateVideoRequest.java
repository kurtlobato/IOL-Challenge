package com.iol.video.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

public record CreateVideoRequest(
    @NotBlank @Size(max = 512) String title,
    @NotBlank @Size(max = 512) String originalFilename,
    @Size(max = 256) String contentType,
    @Positive Long sizeBytes) {}
