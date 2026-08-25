const commandQueues = new Map<string, Promise<void>>();

/** Process-local serialization only; this is not a cross-process exactly-once claim. */
export function enqueueTaskCommand<T>(queueKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = commandQueues.get(queueKey) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  commandQueues.set(queueKey, tail);
  return result.finally(() => {
    if (commandQueues.get(queueKey) === tail) commandQueues.delete(queueKey);
  });
}

export function taskCommandQueueKey(taskId: string, taskInstanceId?: string): string {
  // Student balances and assignment/completion ledgers are shared resources. Keep every
  // task command in one conservative process-local critical section so separate store
  // wrappers and separate task instances cannot overwrite one another's observations.
  void taskId;
  void taskInstanceId;
  return 'ALL_TASK_MUTATIONS';
}
