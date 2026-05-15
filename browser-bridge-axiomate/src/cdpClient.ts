/**
 * Thin façade over chrome-remote-interface.
 *
 * Why a wrapper? Two reasons: (1) consolidate the slightly awkward CRI API
 * shape (positional+optional callback vs the promise-style we want), and (2)
 * give us a single seam to swap CRI for a hand-rolled WebSocket client if
 * upstream behavior changes.
 *
 * CRI's session handling: when we call `Target.setAutoAttach { flatten: true }`,
 * subsequent attachedToTarget events deliver a sessionId. CRI's `.send(method,
 * params, sessionId)` routes follow-up calls onto that session. We surface the
 * same parameter order so callers don't have to learn two conventions.
 */

import CDP from "chrome-remote-interface";

export interface CdpConnectOptions {
  host?: string;
  port: number;
  /** Specific target id (defaults to the first `type:"page"` target). */
  target?: string;
  /** Path through `chrome-remote-interface`'s `local` option for hermetic tests. */
  local?: boolean;
}

export type CdpEventListener = (params: any, sessionId?: string) => void;

export class CdpClient {
  private constructor(private raw: any) {}

  static async connect(opts: CdpConnectOptions): Promise<CdpClient> {
    const host = opts.host ?? "127.0.0.1";
    const client = await CDP({
      host,
      port: opts.port,
      target: opts.target,
      local: opts.local,
    });
    return new CdpClient(client);
  }

  /**
   * Send a CDP command. `sessionId` routes to a child target attached via
   * `Target.setAutoAttach { flatten: true }`; omit for the root target.
   */
  async send<T = any>(
    method: string,
    params?: any,
    sessionId?: string,
  ): Promise<T> {
    // CRI's send signature: `send(method, params, sessionId, callback)`. We
    // bypass the optional callback and rely on the promise-returning path.
    return await this.raw.send(method, params ?? {}, sessionId);
  }

  /**
   * Subscribe to a CDP event. `listener` receives `(params, sessionId?)` so
   * multi-session consumers can dispatch on origin. Events for the root
   * target deliver `sessionId === undefined`.
   */
  on(event: string, listener: CdpEventListener): void {
    this.raw.on(event, listener);
  }

  /** Remove a previously-registered listener. */
  off(event: string, listener: CdpEventListener): void {
    if (typeof this.raw.off === "function") {
      this.raw.off(event, listener);
    } else if (typeof this.raw.removeListener === "function") {
      this.raw.removeListener(event, listener);
    }
  }

  async close(): Promise<void> {
    await this.raw.close();
  }
}
