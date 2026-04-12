export function formatVideoDurationHms(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Texto tipo YouTube-ES para la línea de vistas debajo del título. */
export function formatViewsLine(viewCount: number): string {
  if (viewCount <= 0) {
    return "Sin visualizaciones";
  }
  if (viewCount === 1) {
    return "1 visualización";
  }
  const compact = new Intl.NumberFormat("es", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(viewCount);
  return `${compact} visualizaciones`;
}
