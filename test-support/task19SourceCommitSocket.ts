import { createHash } from 'node:crypto';
import { SurvivingTransportSocket } from './task19SurvivingTransport';

type ResponseEvidence = Parameters<SurvivingTransportSocket['arm']>[0] extends (value: infer T) => void ? T : never;
export type SourceWireEvidence = ResponseEvidence & {
  boundary: 'SOURCE_COMMIT_RESPONSE' | 'SOURCE_COMMIT_NOT_FORWARDED';
  frontendHex?: string;
};

/** Test-only source-side cut. Both branches let pg submit its real COMMIT and
 * leave its Promise pending. Commit: forward real bytes, withhold the actual
 * server response. Abort: hold the whole frontend frame before the native pipe.
 * Only closeNativeTransport causes the driver failure. No SQL abort trigger,
 * ErrorResponse injection, timeout, pg.end(), or application death is used. */
export class SourceCommitSocket extends SurvivingTransportSocket {
  private beforeSubmit?: (evidence: SourceWireEvidence) => void;
  private sourceArmed = false;
  armSource(outcome: 'commit' | 'rollback', ready: (evidence: SourceWireEvidence) => void) {
    if (this.sourceArmed) throw new Error('Source fault must be armed exactly once');
    this.sourceArmed = true;
    if (outcome === 'commit') this.arm(value => ready({ ...value, boundary: 'SOURCE_COMMIT_RESPONSE' }));
    else this.beforeSubmit = ready;
  }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (!this.beforeSubmit) return super._write(chunk, encoding, callback);
    if (chunk.length !== 12 || chunk[0] !== 81 || chunk.readInt32BE(1) !== 11
      || chunk.subarray(5).toString('utf8') !== 'COMMIT\0') {
      callback(new Error('Unexpected frontend at source COMMIT boundary')); return;
    }
    const ready = this.beforeSubmit; this.beforeSubmit = undefined;
    // This is a transport write completion, not a pg query response/ACK.
    // Do not forward any byte; native EOF aborts the still-open transaction.
    callback();
    ready({ frontend: 'Q', query: 'COMMIT', submitted: false, withheldBytes: 0,
      rawHex: '', sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), frames: [],
      deliveredCommitResponseBytes: 0, driverResponseInjected: false,
      boundary: 'SOURCE_COMMIT_NOT_FORWARDED', frontendHex: chunk.toString('hex') });
  }
}
