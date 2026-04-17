import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiBase, listVideos, recordView, setApiBase } from "./api";

const mem: Record<string, string> = {};

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v;
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
  } as Storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listVideos", () => {
  it("usa /api/videos por defecto", async () => {
    const list: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => list,
      }),
    );
    await expect(listVideos()).resolves.toEqual([]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/videos");
  });

  it("pide federado con query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );
    await listVideos({ federated: true });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/videos?federated=true");
  });
});

describe("setApiBase / getApiBase", () => {
  it("prefija el origen en fetch", async () => {
    setApiBase("http://192.168.1.10:8080");
    expect(getApiBase()).toBe("http://192.168.1.10:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );
    await listVideos();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://192.168.1.10:8080/api/videos",
    );
  });
});

describe("recordView", () => {
  it("envía POST a apiOrigin si se pasa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ viewCount: 3 }),
      }),
    );
    const c = await recordView("n:v", "k", 12, "http://peer:8080");
    expect(c).toBe(3);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://peer:8080/api/videos/n%3Av/views",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
