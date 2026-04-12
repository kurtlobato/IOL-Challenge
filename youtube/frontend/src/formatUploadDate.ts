/** Fecha larga para el detalle: «4 de Marzo de 1997». */
export function formatFullUploadDateDetail(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const s = new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);

  const parts = s.split(" de ");
  if (parts.length === 3) {
    const [day, month, year] = parts;
    const m = month.charAt(0).toLocaleUpperCase("es-ES") + month.slice(1);
    return `${day} de ${m} de ${year}`;
  }
  return s;
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function calendarMonthsBetween(earlier: Date, later: Date): number {
  let m =
    (later.getFullYear() - earlier.getFullYear()) * 12 +
    (later.getMonth() - earlier.getMonth());
  if (later.getDate() < earlier.getDate()) m -= 1;
  return Math.max(0, m);
}

function calendarYearsBetween(earlier: Date, later: Date): number {
  let y = later.getFullYear() - earlier.getFullYear();
  if (
    later.getMonth() < earlier.getMonth() ||
    (later.getMonth() === earlier.getMonth() && later.getDate() < earlier.getDate())
  ) {
    y -= 1;
  }
  return Math.max(0, y);
}

/** Texto relativo para la grilla principal (es-ES). */
export function formatRelativeUploadDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";

  const today = startOfLocalDay(now);
  const thatDay = startOfLocalDay(d);
  const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86_400_000);

  if (diffDays < 0) return formatFullUploadDateDetail(iso);
  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  if (diffDays < 7) return `Hace ${diffDays} días`;

  if (diffDays < 30) {
    const w = Math.floor(diffDays / 7);
    const n = Math.max(1, w);
    return n === 1 ? "Hace 1 semana" : `Hace ${n} semanas`;
  }

  const months = calendarMonthsBetween(d, now);
  if (months < 12) {
    return months === 1 ? "Hace 1 mes" : `Hace ${months} meses`;
  }

  const years = calendarYearsBetween(d, now);
  return years === 1 ? "Hace 1 año" : `Hace ${years} años`;
}
