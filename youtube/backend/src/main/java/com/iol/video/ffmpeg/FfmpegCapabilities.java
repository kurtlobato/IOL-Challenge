package com.iol.video.ffmpeg;

import com.iol.video.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Detects whether {@code h264_nvenc} can be used (listed by FFmpeg and a minimal encode succeeds).
 * Controlled by {@code app.ffmpeg.hardware-accel}.
 */
@Component
public class FfmpegCapabilities {

  private static final Logger log = LoggerFactory.getLogger(FfmpegCapabilities.class);

  private final boolean useNvencForHls;

  public FfmpegCapabilities(AppProperties app) {
    String mode = resolveMode(app.ffmpeg().hardwareAccel());
    String bin = app.ffmpeg().command();
    boolean wantNvenc = !"none".equals(mode);
    boolean listed = wantNvenc && encodersListContainsH264Nvenc(bin);
    boolean runtimeOk = listed && nvencSmokeTest(bin);
    this.useNvencForHls = wantNvenc && runtimeOk;
    if ("nvenc".equals(mode) && !runtimeOk) {
      log.warn(
          "app.ffmpeg.hardware-accel=nvenc but NVENC is not usable (missing encoder, GPU, or driver); "
              + "falling back to libx264");
    }
    log.info(
        "FFmpeg HLS video encoder: {} (mode={}, h264_nvenc listed={}, smoke test={})",
        useNvencForHls ? "h264_nvenc" : "libx264",
        mode,
        listed,
        runtimeOk);
  }

  public boolean useNvencForHls() {
    return useNvencForHls;
  }

  private String resolveMode(String raw) {
    if (raw == null || raw.isBlank()) {
      return "auto";
    }
    String m = raw.trim().toLowerCase(Locale.ROOT);
    return switch (m) {
      case "none", "off" -> "none";
      case "nvenc", "cuda" -> "nvenc";
      case "auto" -> "auto";
      default -> {
        log.warn("Unknown app.ffmpeg.hardware-accel '{}', using auto", m);
        yield "auto";
      }
    };
  }

  static boolean encodersListContainsH264Nvenc(String ffmpegBinary) {
    try {
      ProcessBuilder pb = new ProcessBuilder(ffmpegBinary, "-hide_banner", "-encoders");
      pb.redirectErrorStream(true);
      Process p = pb.start();
      if (!p.waitFor(20, TimeUnit.SECONDS)) {
        p.destroyForcibly();
        return false;
      }
      if (p.exitValue() != 0) {
        return false;
      }
      String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      return encodersOutputContainsH264Nvenc(out);
    } catch (Exception e) {
      log.debug("ffmpeg -encoders failed: {}", e.getMessage());
      return false;
    }
  }

  /** Visible for tests: {@code ffmpeg -encoders} stdout/stderr. */
  static boolean encodersOutputContainsH264Nvenc(String encodersOutput) {
    return encodersOutput != null && encodersOutput.contains("h264_nvenc");
  }

  private boolean nvencSmokeTest(String ffmpegBinary) {
    try {
      ProcessBuilder pb =
          new ProcessBuilder(
              ffmpegBinary,
              "-hide_banner",
              "-loglevel",
              "error",
              "-f",
              "lavfi",
              "-i",
              "testsrc2=size=320x240:rate=1",
              "-frames:v",
              "1",
              "-c:v",
              "h264_nvenc",
              "-f",
              "null",
              "-");
      pb.redirectErrorStream(true);
      Process p = pb.start();
      if (!p.waitFor(12, TimeUnit.SECONDS)) {
        p.destroyForcibly();
        log.debug("NVENC smoke test timed out");
        return false;
      }
      drainQuietly(p);
      boolean ok = p.exitValue() == 0;
      if (!ok) {
        log.debug("NVENC smoke test exit code {}", p.exitValue());
      }
      return ok;
    } catch (Exception e) {
      log.debug("NVENC smoke test failed: {}", e.getMessage());
      return false;
    }
  }

  private static void drainQuietly(Process p) {
    try {
      p.getInputStream().readAllBytes();
    } catch (Exception ignored) {
    }
  }
}
