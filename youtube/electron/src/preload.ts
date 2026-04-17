import { contextBridge, ipcRenderer } from "electron";
import type { DiscoveredNode } from "./types";

type Unsub = () => void;

contextBridge.exposeInMainWorld("lanflix", {
  listNodes: async (): Promise<DiscoveredNode[]> => {
    return (await ipcRenderer.invoke("discovery:listNodes")) as DiscoveredNode[];
  },
  onNodesChanged: (cb: (nodes: DiscoveredNode[]) => void): Unsub => {
    const handler = (_ev: unknown, nodes: DiscoveredNode[]) => cb(nodes);
    ipcRenderer.on("discovery:nodesChanged", handler);
    return () => ipcRenderer.off("discovery:nodesChanged", handler);
  },
});

