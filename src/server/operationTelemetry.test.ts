import { describe, expect, it, vi } from 'vitest';
import { emitOperationStage } from './operationTelemetry';

describe('operation telemetry', () => {
  it('emits only the explicit privacy-safe stage fields', () => {
    const sink = vi.fn();
    emitOperationStage({
      requestId: 'req-1', operationId: 'op-1', stage: 'queue_wait', durationMs: 42.8,
      resultCode: 'STARTED', retryCount: 1,
      studentId: 'must-not-leak', balance: 999, spreadsheetId: 'must-not-leak',
    } as never, sink);

    expect(sink).toHaveBeenCalledOnce();
    const payload = JSON.parse(sink.mock.calls[0][0]);
    expect(payload).toEqual({
      event: 'task_operation_stage', requestId: 'req-1', operationId: 'op-1', stage: 'queue_wait',
      durationMs: 43, resultCode: 'STARTED', retryCount: 1,
    });
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
    expect(JSON.stringify(payload)).not.toContain('999');
  });
});
