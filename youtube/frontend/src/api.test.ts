import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeVideo,
  createVideo,
  deleteVideo,
  getOriginalDownloadLink,
  getVideo,
  listVideos,
  uploadToPresigned,
} from "./api";

const jsonHeaders = { "Content-Type": "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createVideo", () => {
  it("parsea respuesta 201", async () => {
    const body = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      uploadUrl: "https://minio/put",
      method: "PUT",
      objectKey: "originals/x/source",
      expiresInSeconds: 900,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => body,
      }),
    );

    const out = await createVideo({
      title: "t",
      originalFilename: "a.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
      uploaderId: "u1",
    });

    expect(out).toEqual(body);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/videos",
      expect.objectContaining({
        method: "POST",
        headers: jsonHeaders,
      }),
    );
  });

  it("lanza con mensaje del JSON de error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ error: "Video exceeds maximum allowed size" }),
      }),
    );

    await expect(
      createVideo({
        title: "t",
        originalFilename: "a.mp4",
        contentType: "video/mp4",
        sizeBytes: 999999999,
        uploaderId: "u1",
      }),
    ).rejects.toThrow("Video exceeds maximum allowed size");
  });
});

describe("completeVideo", () => {
  it("no lanza en 204", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      }),
    );
    await expect(
      completeVideo("550e8400-e29b-41d4-a716-446655440000"),
    ).resolves.toBeUndefined();
  });

  it("lanza si no ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Conflict" }),
      }),
    );
    await expect(completeVideo("x")).rejects.toThrow("Conflict");
  });
});

describe("getVideo / listVideos", () => {
  it("listVideos devuelve array", async () => {
    const list = [{ id: "1", title: "a", status: "READY" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => list,
      }),
    );
    await expect(listVideos()).resolves.toEqual(list);
  });

  it("getVideo devuelve un ítem", async () => {
    const item = { id: "1", title: "a", status: "READY" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => item,
      }),
    );
    await expect(getVideo("1")).resolves.toEqual(item);
  });
});

describe("uploadToPresigned", () => {
  it("PUT con tipo de archivo", async () => {
    let xhr: {
      method: string;
      url: string;
      headers: Record<string, string>;
      status: number;
      statusText: string;
      onload: (() => void) | null;
      upload: { onprogress: ((ev: ProgressEvent) => void) | null };
      open: (m: string, u: string) => void;
      setRequestHeader: (k: string, v: string) => void;
      send: () => void;
    } | null = null;
    class MockXHR {
      upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
      status = 200;
      statusText = "OK";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      method = "";
      url = "";
      headers: Record<string, string> = {};
      constructor() {
        xhr = this;
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
    const file = new File(["x"], "a.mp4", { type: "video/mp4" });
    await uploadToPresigned("https://example/presign", file, "PUT");
    expect(xhr?.method).toBe("PUT");
    expect(xhr?.url).toBe("https://example/presign");
    expect(xhr?.headers["Content-Type"]).toBe("video/mp4");
  });

  it("lanza si el PUT falla", async () => {
    class MockXHR {
      upload = { onprogress: null as ((ev: ProgressEvent) => void) | null };
      status = 403;
      statusText = "Forbidden";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      method = "";
      url = "";
      headers: Record<string, string> = {};
      open(_method: string, _url: string) {}
      setRequestHeader(_name: string, _value: string) {}
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
    const file = new File(["x"], "a.mp4");
    await expect(uploadToPresigned("https://x", file, "PUT")).rejects.toThrow(/403/);
  });
});

describe("getOriginalDownloadLink", () => {
  it("omite uploaderId si no se pasa", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "https://x", filename: "a.mp4" }),
      }),
    );
    await expect(getOriginalDownloadLink("vid-1")).resolves.toEqual({
      url: "https://x",
      filename: "a.mp4",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/videos/vid-1/original-download");
  });
});

describe("deleteVideo", () => {
  it("codifica uploaderId en query", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    );
    await deleteVideo("vid-1", "user a/b");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/videos/vid-1?uploaderId=user%20a%2Fb",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
