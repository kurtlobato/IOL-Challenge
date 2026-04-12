/** Duración total (s) para umbrales de reproducción: API > manifiesto HLS > seekable > media. */
export function resolveTotalDurationSeconds(
  apiDurationSeconds: number | null | undefined,
  videoDuration: number,
  seekableEnd: number | null,
  hlsTotalDuration: number | null,
): number | null {
  if (
    apiDurationSeconds != null &&
    Number.isFinite(apiDurationSeconds) &&
    apiDurationSeconds > 0
  ) {
    return apiDurationSeconds;
  }
  if (hlsTotalDuration != null && Number.isFinite(hlsTotalDuration) && hlsTotalDuration > 0) {
    return hlsTotalDuration;
  }
  if (seekableEnd != null && Number.isFinite(seekableEnd) && seekableEnd > 0) {
    return seekableEnd;
  }
  if (Number.isFinite(videoDuration) && videoDuration > 0) {
    return videoDuration;
  }
  return null;
}

export function readSeekableEndSeconds(video: {
  seekable: TimeRanges;
}): number | null {
  try {
    const r = video.seekable;
    if (!r || r.length === 0) return null;
    const end = r.end(r.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Si `currentTime` salta hacia atrás sin un seek de usuario, acumula el tramo previo
 * (p. ej. línea de tiempo discontinua / fallos del motor) para no comparar solo el
 * tiempo dentro del fragmento actual contra la duración total.
 */
export function nextStitchedTimelineState(
  prev: { carried: number; lastCurrent: number },
  currentTime: number,
): { carried: number; lastCurrent: number } {
  if (!Number.isFinite(currentTime) || currentTime < 0) {
    return { ...prev };
  }
  let carried = prev.carried;
  const last = prev.lastCurrent;
  if (last > 3 && currentTime < last * 0.15 && currentTime < 2) {
    carried += last;
  }
  return { carried, lastCurrent: currentTime };
}

export function resetStitchedTimeline(): { carried: number; lastCurrent: number } {
  return { carried: 0, lastCurrent: 0 };
}
