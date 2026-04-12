package com.iol.video.web.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record RegisterViewRequest(
    @NotBlank @Size(max = 128) String viewerKey,
    @NotNull @DecimalMin(value = "0.0", inclusive = true) Double watchedSeconds) {}
