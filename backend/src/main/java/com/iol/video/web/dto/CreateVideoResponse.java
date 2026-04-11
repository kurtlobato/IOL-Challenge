package com.iol.video.web.dto;

import java.util.UUID;

public record CreateVideoResponse(
    UUID id,
    String uploadUrl,
    String method,
    String objectKey,
    int expiresInSeconds) {}
