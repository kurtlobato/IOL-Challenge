import { describe, expect, it } from "vitest";
import {
  nextStitchedTimelineState,
  readSeekableEndSeconds,
  resolveTotalDurationSeconds,
  resetStitchedTimeline,
} from "./viewPlaybackMetrics";

describe("resolveTotalDurationSeconds", () => {
  it("prioriza duración API", () => {
    expect(resolveTotalDurationSeconds(100, 50, 80, 90)).toBe(100);
  });

  it("sin API usa HLS total", () => {
    expect(resolveTotalDurationSeconds(null, 50, 80, 90)).toBe(90);
  });

  it("sin API ni HLS usa seekable", () => {
    expect(resolveTotalDurationSeconds(null, 50, 80, null)).toBe(80);
  });

  it("solo media usa duration del elemento", () => {
    expect(resolveTotalDurationSeconds(null, 42, null, null)).toBe(42);
  });

  it("rechaza API no finita y cae a siguiente", () => {
    expect(resolveTotalDurationSeconds(Number.NaN, 10, null, 20)).toBe(20);
  });
});

describe("readSeekableEndSeconds", () => {
  it("lee el final del último rango", () => {
    const video = {
      seekable: {
        length: 2,
        end: (i: number) => (i === 1 ? 99 : 10),
      },
    };
    expect(readSeekableEndSeconds(video as unknown as HTMLVideoElement)).toBe(99);
  });
});

describe("nextStitchedTimelineState", () => {
  it("no acumula al inicio", () => {
    const s0 = resetStitchedTimeline();
    expect(nextStitchedTimelineState(s0, 0.5)).toEqual({ carried: 0, lastCurrent: 0.5 });
  });

  it("acumula salto atrás brusco típico de reinicio de línea de tiempo", () => {
    let s = resetStitchedTimeline();
    s = nextStitchedTimelineState(s, 5);
    s = nextStitchedTimelineState(s, 5.8);
    s = nextStitchedTimelineState(s, 0.1);
    expect(s.carried).toBeGreaterThan(0);
    expect(s.lastCurrent).toBe(0.1);
    const effective = s.carried + s.lastCurrent;
    expect(effective).toBeGreaterThan(5.8);
  });

  it("no acumula avance normal", () => {
    let s = resetStitchedTimeline();
    for (const t of [1, 2, 3, 4, 5]) {
      s = nextStitchedTimelineState(s, t);
    }
    expect(s).toEqual({ carried: 0, lastCurrent: 5 });
  });
});
