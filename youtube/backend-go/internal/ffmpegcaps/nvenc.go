// Package ffmpegcaps detecta si FFmpeg puede usar h264_nvenc de forma fiable.
package ffmpegcaps

import (
	"context"
	"log"
	"os/exec"
	"strings"
	"time"
)

// ResolveHardwareAccelMode normaliza valores como en el backend Java (auto/none/nvenc).
func ResolveHardwareAccelMode(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "auto"
	}
	m := strings.ToLower(strings.TrimSpace(raw))
	switch m {
	case "none", "off":
		return "none"
	case "nvenc", "cuda":
		return "nvenc"
	case "auto":
		return "auto"
	default:
		log.Printf("lanflix: ffmpeg_hardware_accel desconocido %q; usando auto", raw)
		return "auto"
	}
}

// EncodersOutputContainsH264NVENC interpreta la salida de `ffmpeg -encoders`.
func EncodersOutputContainsH264NVENC(encodersOutput string) bool {
	return strings.Contains(encodersOutput, "h264_nvenc")
}

func encodersListHasNVENC(ctx context.Context, ffmpegBin string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegBin, "-hide_banner", "-encoders")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return false, err
	}
	return EncodersOutputContainsH264NVENC(string(out)), nil
}

func nvencSmokeTest(ctx context.Context, ffmpegBin string) bool {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegBin,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1",
		"-frames:v", "1",
		"-c:v", "h264_nvenc",
		"-f", "null", "-",
	)
	_, err := cmd.CombinedOutput()
	return err == nil
}

// UseNVENC indica si la transcodificación debe usar h264_nvenc (NVIDIA).
// hardwareAccelRaw: "", auto, none, off, nvenc, cuda.
func UseNVENC(ctx context.Context, ffmpegBin string, hardwareAccelRaw string) bool {
	mode := ResolveHardwareAccelMode(hardwareAccelRaw)
	if mode == "none" {
		log.Printf("lanflix: transcode vídeo: libx264 (ffmpeg_hardware_accel=none)")
		return false
	}

	listed, err := encodersListHasNVENC(ctx, ffmpegBin)
	if err != nil {
		log.Printf("lanflix: ffmpeg -encoders: %v; usando libx264", err)
		if mode == "nvenc" {
			log.Printf("lanflix: ffmpeg_hardware_accel=nvenc pero NVENC no está disponible; usando libx264")
		}
		return false
	}

	smokeOk := false
	if listed {
		smokeOk = nvencSmokeTest(ctx, ffmpegBin)
	}
	use := listed && smokeOk
	enc := "libx264"
	if use {
		enc = "h264_nvenc"
	}
	if mode == "nvenc" && !use {
		log.Printf("lanflix: ffmpeg_hardware_accel=nvenc pero NVENC no está disponible (encoder/GPU/driver); usando libx264")
	}
	log.Printf("lanflix: transcode vídeo: %s (hardware_accel=%s, h264_nvenc listado=%v, prueba_nvenc=%v)", enc, mode, listed, smokeOk)
	return use
}
