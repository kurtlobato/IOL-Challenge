import type { SeriesRef, VideoItem } from "./api";

export type SeriesSummary = {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  episodeCount: number;
};

export function normalizeSeriesGroupTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Clave estable para unir la misma serie en distintos nodos (solo título normalizado). */
export function seriesGroupKey(series: Pick<SeriesRef, "title">): string {
  return `grp:${normalizeSeriesGroupTitle(series.title)}`;
}

export function episodeMatchesBrowse(
  v: VideoItem,
  browseSeriesId: string,
  federated: boolean,
): boolean {
  if (!v.series) return false;
  return federated ? seriesGroupKey(v.series) === browseSeriesId : v.series.id === browseSeriesId;
}

/** Una tarjeta por serie; con federación, misma obra en varios nodos → un solo grupo. */
export function seriesSummariesFromItems(
  items: VideoItem[],
  mergeAcrossNodes: boolean,
): SeriesSummary[] {
  const acc = new Map<string, { title: string; thumb: string | null; count: number }>();
  for (const v of items) {
    const s = v.series;
    if (!s) continue;
    const key = mergeAcrossNodes ? seriesGroupKey(s) : s.id;
    if (!acc.has(key)) {
      acc.set(key, {
        title: s.title,
        thumb: s.thumbnailUrl ?? v.thumbnailUrl ?? null,
        count: 0,
      });
    }
    const row = acc.get(key)!;
    row.count++;
    if (!row.thumb) {
      row.thumb = s.thumbnailUrl ?? v.thumbnailUrl ?? null;
    }
    if (s.title.length > row.title.length) {
      row.title = s.title;
    }
  }
  return [...acc.entries()]
    .map(([id, x]) => ({
      id,
      title: x.title,
      thumbnailUrl: x.thumb,
      episodeCount: x.count,
    }))
    .sort((a, b) => a.title.localeCompare(b.title, "es"));
}

export function browseSeriesTitleFromItems(
  items: VideoItem[],
  browseSeriesId: string | null,
  federated: boolean,
): string {
  if (!browseSeriesId) return "Serie";
  const first = items.find((v) => episodeMatchesBrowse(v, browseSeriesId, federated));
  return first?.series?.title ?? "Serie";
}
