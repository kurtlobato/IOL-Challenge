package com.iol.video.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record UpdateVideoRequest(@NotBlank @Size(max = 512) String title) {}
