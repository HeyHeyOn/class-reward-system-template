import { Duplex } from 'node:stream';
import { CommitWireSocket } from './task19CommitWire';

/** Test-only deterministic transport loss, not a synthetic pg error. Real COMMIT
 * bytes are held by the predecessor parser. Once the independent owner has read
 * the outcome, EOF on docker-exec stdin makes pgStdioRelay.c shutdown(SHUT_WR)
 * its actual AF_UNIX socket; server EOF then closes the relay/socket naturally.
 * Unlike the process-death harness, native EOF is delivered, not replaced by an
 * Error. pg itself rejects its pending query on Connection 'end'. */
export class SurvivingTransportSocket extends CommitWireSocket {
  readonly events: { event: string; message?: string }[] = [];
  private requested = false;
  constructor(container: string, environment: NodeJS.ProcessEnv) {
    super(container, environment);
    this.on('end', () => this.events.push({ event: 'readable-end' }));
    this.on('close', () => this.events.push({ event: 'stream-close' }));
    this.on('error', error => this.events.push({ event: 'stream-error', message: error.message }));
  }
  closeNativeTransport() {
    if (this.requested || this.destroyed) throw new Error('Transport close requires a live one-shot socket');
    this.requested = true;
    this.events.push({ event: 'relay-stdin-end-requested' });
    // Do NOT call pg.end(), destroy(error), emit(error), kill(), or feed a fake
    // backend ErrorResponse. This ends only this exact stream's native pipe.
    super._final(error => {
      this.events.push({ event: 'relay-stdin-ended', ...(error ? { message: error.message } : {}) });
    });
  }
  override push(chunk: Buffer | null, encoding?: BufferEncoding): boolean {
    if (chunk !== null) return super.push(chunk, encoding);
    this.events.push({ event: 'native-relay-stdout-eof' });
    // Bypass only the predecessor's deliberate-process-death EOF error. Preserve
    // native Duplex EOF and the existing ExecSocket native child close handling.
    return Duplex.prototype.push.call(this, null, encoding);
  }
}
