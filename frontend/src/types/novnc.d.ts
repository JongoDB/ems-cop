declare module '@novnc/novnc/lib/rfb' {
  interface RFBCredentials {
    password?: string;
  }

  interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    scaleViewport: boolean;
    resizeSession: boolean;
    background: string;
    disconnect(): void;
    addEventListener(type: string, listener: (e: CustomEvent) => void): void;
    removeEventListener(type: string, listener: (e: CustomEvent) => void): void;
  }

  export default RFB;
}
