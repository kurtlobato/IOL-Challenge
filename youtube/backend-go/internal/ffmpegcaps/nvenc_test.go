package ffmpegcaps

import "testing"

func TestResolveHardwareAccelMode(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in, want string
	}{
		{"", "auto"},
		{"  ", "auto"},
		{"auto", "auto"},
		{"NONE", "none"},
		{"off", "none"},
		{"nvenc", "nvenc"},
		{"CUDA", "nvenc"},
	}
	for _, tc := range tests {
		if got := ResolveHardwareAccelMode(tc.in); got != tc.want {
			t.Fatalf("ResolveHardwareAccelMode(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestEncodersOutputContainsH264NVENC(t *testing.T) {
	t.Parallel()
	if !EncodersOutputContainsH264NVENC(" V..... h264_nvenc           NVIDIA NVENC H.264 encoder") {
		t.Fatal("expected true")
	}
	if EncodersOutputContainsH264NVENC(" V..... libx264           H.264") {
		t.Fatal("expected false")
	}
	if EncodersOutputContainsH264NVENC("") {
		t.Fatal("expected false")
	}
}
