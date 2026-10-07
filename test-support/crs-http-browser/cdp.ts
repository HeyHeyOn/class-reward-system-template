import { setTimeout as delay } from 'node:timers/promises';

export type CdpEvent = {
  method: string;
  sessionId?: string;
  params: Record<string, unknown>;
};

// Native Node WebSocket, no missing Playwright package or downloaded browser.
// Connections are created only after acceptance.ts checks the live boundary.
export class Cdp {
  readonly events: CdpEvent[] = [];
  private nextId = 0;
  private failure: Error | undefined;
  private openingFailure: ((error: Error) => void) | undefined;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      if (this.failure) return;
      try {
        const message = JSON.parse(String(event.data));
        if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error('CDP command rejected (raw payload withheld)'));
          else pending.resolve(message.result);
        } else if (typeof message.method === 'string') {
          if (this.events.length >= 20_000) throw new Error('CDP event bound exceeded');
          this.events.push(message as CdpEvent);
        }
      } catch {
        this.stop(new Error('Invalid or oversized CDP event stream'));
      }
    });
    socket.addEventListener('error', () => this.stop(new Error('CDP transport failed')));
    socket.addEventListener('close', () => this.stop(new Error('CDP transport closed')));
  }

  static async connect(url: string): Promise<Cdp> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1'
      || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(parsed.pathname)) {
      throw new Error('Only owned literal loopback CDP is admitted');
    }
    const socket = new WebSocket(url);
    const cdp = new Cdp(socket);
    await new Promise<void>((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        cdp.openingFailure = undefined;
      };
      const opened = () => { clear(); resolve(); };
      const timer = setTimeout(() => cdp.stop(new Error('CDP open timeout')), 10_000);
      cdp.openingFailure = error => { clear(); reject(error); };
      socket.addEventListener('open', opened, { once: true });
    });
    return cdp;
  }

  private stop(error: Error) {
    // Preserve the first cause and settle both handshake and command waiters.
    // Closing the socket may synchronously/ asynchronously emit another error.
    if (this.failure) return;
    this.failure = error;
    this.openingFailure?.(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    if (this.socket.readyState < 2) this.socket.close();
  }

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.failure) throw this.failure;
    const id = ++this.nextId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { this.pending.get(id)?.reject(new Error('CDP send failed')); this.pending.delete(id); }
    });
  }

  async event(method: string, after: number, predicate: (event: CdpEvent) => boolean = () => true): Promise<CdpEvent> {
    const end = performance.now() + 15_000;
    while (performance.now() < end) {
      if (this.failure) throw this.failure;
      const found = this.events.slice(after).find(event => event.method === method && predicate(event));
      if (found) return found;
      await delay(25);
    }
    throw new Error(`CDP event timeout: ${method}`);
  }

  close() { this.stop(new Error('CDP disposed')); }
}
