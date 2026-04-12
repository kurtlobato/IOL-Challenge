package com.iol.video.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.iol.video.config.AppProperties;
import java.util.List;
import org.junit.jupiter.api.Test;

class TranscodeServiceTest {

  @Test
  void buildMasterPlaylist_containsVariantPathsAndBandwidth() {
    List<AppProperties.HlsVariant> variants =
        List.of(
            new AppProperties.HlsVariant("480p", 480, 1_000_000),
            new AppProperties.HlsVariant("720p", 720, 3_000_000));
    String m = TranscodeService.buildMasterPlaylist(variants);
    assertTrue(m.startsWith("#EXTM3U\n"));
    assertTrue(m.contains("480p/index.m3u8"));
    assertTrue(m.contains("720p/index.m3u8"));
    assertTrue(m.contains("#EXT-X-STREAM-INF:BANDWIDTH="));
    assertTrue(m.contains("RESOLUTION="));
  }

  @Test
  void evenWidth16x9_roundsToEvenPixels() {
    assertEquals(854, TranscodeService.evenWidth16x9(480));
    assertEquals(1280, TranscodeService.evenWidth16x9(720));
  }
}
