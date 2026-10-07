export type OperationStage =
  | 'queue_wait'
  | 'client_auth'
  | 'snapshot_read'
  | 'schema_ready'
  | 'policy_validation'
  | 'assignment_materialization'
  | 'pending_checkpoint'
  | 'balance_reconciliation'
  | 'transaction_reconciliation'
  | 'terminal_completion'
  | 'safe_projection'
  | 'total';

export type OperationStageEvent = {
  requestId: string;
  operationId: string;
  stage: OperationStage;
  durationMs: number;
  resultCode: string;
  retryCount: number;
};

export function emitOperationStage(
  event: OperationStageEvent,
  sink: (serialized: string) => void = console.info,
): void {
  sink(JSON.stringify({
    event: 'task_operation_stage',
    requestId: event.requestId,
    operationId: event.operationId,
    stage: event.stage,
    durationMs: Math.max(0, Math.round(event.durationMs)),
    resultCode: event.resultCode,
    retryCount: Math.max(0, Math.trunc(event.retryCount)),
  }));
}
