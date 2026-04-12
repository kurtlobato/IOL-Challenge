import { describe, expect, it } from "vitest";
import { formatFullUploadDateDetail, formatRelativeUploadDate } from "./formatUploadDate";

describe("formatFullUploadDateDetail", () => {
  it("devuelve cadena vacía si ISO inválido", () => {
    expect(formatFullUploadDateDetail("")).toBe("");
    expect(formatFullUploadDateDetail("no-es-fecha")).toBe("");
  });

  it("formatea fecha conocida en español", () => {
    const s = formatFullUploadDateDetail("1997-03-04T12:00:00.000Z");
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/1997|4|Marzo|marzo/i);
  });
});

describe("formatRelativeUploadDate", () => {
  it("devuelve cadena vacía si ISO inválido", () => {
    expect(formatRelativeUploadDate("", new Date("2026-06-01T12:00:00.000Z"))).toBe("");
  });

  it("Hoy cuando mismo día calendario local", () => {
    const now = new Date(2026, 5, 15, 14, 0, 0);
    const sameDay = new Date(2026, 5, 15, 8, 0, 0).toISOString();
    expect(formatRelativeUploadDate(sameDay, now)).toBe("Hoy");
  });

  it("Ayer para el día anterior", () => {
    const now = new Date(2026, 5, 15, 14, 0, 0);
    const yesterday = new Date(2026, 5, 14, 10, 0, 0).toISOString();
    expect(formatRelativeUploadDate(yesterday, now)).toBe("Ayer");
  });

  it("fecha futura cae en detalle largo", () => {
    const now = new Date(2020, 0, 1, 12, 0, 0);
    const future = new Date(2030, 0, 1, 12, 0, 0).toISOString();
    const s = formatRelativeUploadDate(future, now);
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toBe("Hoy");
  });

  it("hace varios años para fechas muy antiguas", () => {
    const now = new Date(2026, 0, 15, 12, 0, 0);
    const old = new Date(2010, 5, 1, 12, 0, 0).toISOString();
    expect(formatRelativeUploadDate(old, now)).toMatch(/año/);
  });
});
