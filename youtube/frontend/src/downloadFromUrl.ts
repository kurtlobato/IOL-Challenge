/**
 * Descarga un recurso por URL con nombre sugerido. Intenta fetch+blob (respeta nombre en
 * navegadores que lo permitan); si CORS o error, abre la URL en una pestaña nueva.
 */
export async function downloadFromUrl(url: string, suggestedFilename: string): Promise<void> {
  const name = suggestedFilename?.trim() || "video";
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
