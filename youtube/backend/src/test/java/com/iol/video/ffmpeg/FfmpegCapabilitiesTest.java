package com.iol.video.ffmpeg;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class FfmpegCapabilitiesTest {

  @Test
  void encodersOutputContainsH264Nvenc_detectsToken() {
    assertTrue(
        FfmpegCapabilities.encodersOutputContainsH264Nvenc(
            " V..... h264_nvenc           NVIDIA NVENC H.264 encoder"));
    assertFalse(FfmpegCapabilities.encodersOutputContainsH264Nvenc(" V..... libx264           H.264"));
    assertFalse(FfmpegCapabilities.encodersOutputContainsH264Nvenc(null));
  }
}
