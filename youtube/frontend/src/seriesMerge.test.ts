import { describe, expect, it } from "vitest";
import type { VideoItem } from "./api";
import {
  episodeMatchesBrowse,
  normalizeSeriesGroupTitle,
  seriesGroupKey,
  seriesSummariesFromItems,
} from "./seriesMerge";

function vid(p: {
  id: string;
  nodeId: string;
  seriesId: string;
  seriesTitle: string;
}): VideoItem {
  return {
    id: p.id,
    nodeId: p.nodeId,
    title: "Ep",
    status: "READY",
    streamUrl: "http://x/s",
    manifestUrl: null,
    thumbnailUrl: null,
    errorMessage: null,
    uploaderId: null,
    createdAt: new Date().toISOString(),
    progressPercent: null,
    durationSeconds: null,
    viewCount: 0,
    series: {
      id: p.seriesId,
      nodeId: p.nodeId,
      title: p.seriesTitle,
    },
  };
}

describe("seriesMerge", () => {
  it("normaliza título para agrupar", () => {
    expect(normalizeSeriesGroupTitle("  Foo   Bar  ")).toBe("foo bar");
  });

  it("serie equivalente en dos nodos produce una tarjeta federada", () => {
    const items = [
      vid({
        id: "a",
        nodeId: "n1",
        seriesId: "n1:s1",
        seriesTitle: "Mi Serie",
      }),
      vid({
        id: "b",
        nodeId: "n2",
        seriesId: "n2:s9",
        seriesTitle: "Mi Serie",
      }),
    ];
    const merged = seriesSummariesFromItems(items, true);
    expect(merged).toHaveLength(1);
    expect(merged[0].episodeCount).toBe(2);
    expect(merged[0].id).toBe(seriesGroupKey({ title: "Mi Serie" }));
  });

  it("sin merge mantiene ids compuestos por nodo", () => {
    const items = [
      vid({ id: "a", nodeId: "n1", seriesId: "n1:s1", seriesTitle: "Mi Serie" }),
      vid({ id: "b", nodeId: "n2", seriesId: "n2:s9", seriesTitle: "Mi Serie" }),
    ];
    const split = seriesSummariesFromItems(items, false);
    expect(split).toHaveLength(2);
  });

  it("episodeMatchesBrowse con federación usa grp", () => {
    const v = vid({ nodeId: "n1", seriesId: "n1:s1", seriesTitle: "X" });
    const gid = seriesGroupKey({ title: "X" });
    expect(episodeMatchesBrowse(v, gid, true)).toBe(true);
    expect(episodeMatchesBrowse(v, "n1:s1", true)).toBe(false);
    expect(episodeMatchesBrowse(v, "n1:s1", false)).toBe(true);
  });
});
