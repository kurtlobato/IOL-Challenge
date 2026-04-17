/// <reference types="vite/client" />

declare global {
  type DiscoveredNode = {
    nodeId: string;
    name: string;
    host: string;
    port: number;
    baseUrl: string;
    version?: string;
  };

  interface Window {
    lanflix?: {
      listNodes: () => Promise<DiscoveredNode[]>;
      onNodesChanged: (cb: (nodes: DiscoveredNode[]) => void) => () => void;
    };
  }
}

export {};
