import { app, BrowserWindow, ipcMain } from "electron";
import http from "http";
import path from "path";
import { Bonjour } from "bonjour-service";
import sirv from "sirv";
import type { DiscoveredNode } from "./types";

const SERVICE_TYPE = "lanflix";
const SERVICE_PROTOCOL = "tcp";

type NodeEntry = DiscoveredNode & { lastSeenMs: number };

let win: BrowserWindow | null = null;
const byId = new Map<string, NodeEntry>();
const bonjour = new Bonjour();
let staticServer: http.Server | null = null;
let staticServerUrl: string | null = null;

function nowMs() {
  return Date.now();
}

function toBaseUrl(host: string, port: number) {
  // IPv6 literal needs brackets in URL.
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

function pickHost(svc: any): string {
  // bonjour-service provides different fields depending on platform.
  if (typeof svc.referer?.address === "string" && svc.referer.address) return svc.referer.address;
  if (typeof svc.host === "string" && svc.host) return svc.host.replace(/\.$/, "");
  if (Array.isArray(svc.addresses) && svc.addresses.length > 0) return String(svc.addresses[0]);
  return "127.0.0.1";
}

function readTxt(svc: any): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = svc.txt ?? {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (Buffer.isBuffer(v)) out[k] = v.toString("utf8");
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

function upsertFromService(svc: any) {
  const txt = readTxt(svc);
  const nodeId = txt.nodeId || txt.nodeID || "";
  if (!nodeId) return;
  const port = typeof svc.port === "number" ? svc.port : 0;
  if (!port) return;
  const host = pickHost(svc);
  const baseUrl = toBaseUrl(host, port);
  const entry: NodeEntry = {
    nodeId,
    name: txt.name || svc.name || nodeId.slice(0, 8),
    host,
    port,
    baseUrl,
    version: txt.version,
    lastSeenMs: nowMs(),
  };
  byId.set(nodeId, entry);
}

function listNodes(): DiscoveredNode[] {
  const ttlMs = 15_000;
  const cutoff = nowMs() - ttlMs;
  for (const [k, v] of byId.entries()) {
    if (v.lastSeenMs < cutoff) byId.delete(k);
  }
  return Array.from(byId.values())
    .map(({ lastSeenMs: _ls, ...n }) => n)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function broadcastNodes() {
  if (!win) return;
  win.webContents.send("discovery:nodesChanged", listNodes());
}

function startBrowse() {
  const browser = bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL });
  browser.on("up", (svc: any) => {
    upsertFromService(svc);
    broadcastNodes();
  });
  browser.on("down", (svc: any) => {
    const txt = readTxt(svc);
    const nodeId = txt.nodeId || txt.nodeID || "";
    if (nodeId) byId.delete(nodeId);
    broadcastNodes();
  });
  return browser;
}

async function startStaticServer(): Promise<string> {
  if (staticServerUrl) return staticServerUrl;
  const distDir = path.join(__dirname, "..", "..", "frontend", "dist");
  const serve = sirv(distDir, {
    single: true,
    etag: true,
    dev: false,
  });
  staticServer = http.createServer((req, res) => serve(req, res));
  await new Promise<void>((resolve, reject) => {
    staticServer!.listen(0, "127.0.0.1", () => resolve());
    staticServer!.on("error", reject);
  });
  const addr = staticServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("static server: unexpected address");
  }
  staticServerUrl = `http://127.0.0.1:${addr.port}`;
  return staticServerUrl;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const startUrl = process.env.ELECTRON_START_URL;
  if (startUrl) {
    void win.loadURL(startUrl);
  } else {
    const url = await startStaticServer();
    void win.loadURL(url);
  }

  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  void createWindow();
  startBrowse();

  ipcMain.handle("discovery:listNodes", () => listNodes());

  const tick = setInterval(() => broadcastNodes(), 5_000);
  app.on("before-quit", () => {
    clearInterval(tick);
    try {
      staticServer?.close();
    } catch {
      // ignore
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

