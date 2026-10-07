import { createHash } from 'node:crypto';
import { ExecSocket } from '@/server/db/testing/disposablePostgres';

/** Test-only wire fault, never a query adapter. Only real bytes from the exact
 * owned relay are withheld; no database response/error is synthesized. */
export class CommitWireSocket extends ExecSocket {
  private armed = false;
  private held = false;
  private submitted = false;
  private pending = Buffer.alloc(0);
  private chunks: Buffer[] = [];
  private frames: { type: string; bytes: number; tag?: string; sqlState?: string; status?: string }[] = [];
  private done = false;
  private onReady?: (evidence: ReturnType<CommitWireSocket['evidence']>) => void;
  arm(onReady: NonNullable<CommitWireSocket['onReady']>) {
    if (this.armed || this.held) throw new Error('Wire fault must be armed exactly once');
    this.armed = true; this.onReady = onReady;
  }
  private evidence() {
    const bytes = Buffer.concat(this.chunks);
    return { frontend: 'Q', query: 'COMMIT', submitted: this.submitted,
      withheldBytes: bytes.length, rawHex: bytes.toString('hex'), sha256: createHash('sha256').update(bytes).digest('hex'),
      frames: this.frames, deliveredCommitResponseBytes: 0, driverResponseInjected: false };
  }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.armed) {
      // pg's real simple-query serializer emits this one complete frame. Any
      // changed driver protocol is a STOP, not an alternative injection point.
      if (chunk.length !== 12 || chunk[0] !== 81 || chunk.readInt32BE(1) !== 11
        || chunk.subarray(5).toString('utf8') !== 'COMMIT\0') {
        callback(new Error('Unexpected frontend at COMMIT wire boundary')); return;
      }
      this.armed = false; this.held = true;
      super._write(chunk, encoding, error => {
        if (!error) this.submitted = true;
        callback(error); this.publish();
      });
      return;
    }
    super._write(chunk, encoding, callback);
  }
  override push(chunk: Buffer | null, encoding?: BufferEncoding): boolean {
    if (!this.held) return super.push(chunk, encoding);
    if (chunk === null) { this.destroy(new Error('Relay ended before controlled process death')); return false; }
    this.chunks.push(Buffer.from(chunk));
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.chunks.reduce((n, c) => n + c.length, 0) > 65_536) {
      this.destroy(new Error('COMMIT response bound exceeded')); return false;
    }
    while (this.pending.length >= 5) {
      const length = this.pending.readInt32BE(1);
      if (length < 4 || length > 65_536) { this.destroy(new Error('Invalid backend frame')); return false; }
      if (this.pending.length < length + 1) break;
      const type = String.fromCharCode(this.pending[0]), payload = this.pending.subarray(5, length + 1);
      const frame: (typeof this.frames)[number] = { type, bytes: length + 1 };
      if (type === 'C') frame.tag = payload.toString('utf8').replace(/\0$/, '');
      else if (type === 'E') {
        const fields = payload.toString('utf8').split('\0');
        frame.sqlState = fields.find(value => value.startsWith('C'))?.slice(1);
      } else if (type === 'Z' && payload.length === 1) { frame.status = String.fromCharCode(payload[0]); this.done = true; }
      else { this.destroy(new Error('Unexpected backend frame at COMMIT')); return false; }
      this.frames.push(frame); this.pending = this.pending.subarray(length + 1);
    }
    this.publish();
    return true; // Consume from the relay, NEVER feed any held byte into pg.
  }
  private publish() {
    if (this.submitted && this.done && this.onReady) {
      if (this.pending.length) { this.destroy(new Error('Trailing COMMIT response')); return; }
      const publish = this.onReady; this.onReady = undefined; publish(this.evidence());
    }
  }
}
