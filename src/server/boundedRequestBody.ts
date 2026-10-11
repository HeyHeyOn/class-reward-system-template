import 'server-only';

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? 'Request body is too large.' : 'Invalid request body.');
    this.name = 'RequestBodyError';
  }
}

/** Reads unencoded UTF-8 up to a byte limit, including bodies without a reliable length header. */
export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid request body limit.');
  const rejectBeforeRead = (status: 400 | 413): never => {
    // Cancellation may wait on a remote producer. Do not make the error response wait for it.
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyError(status);
  };
  if (request.headers.has('content-encoding')) rejectBeforeRead(400);
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) rejectBeforeRead(400);
    if (Number(declaredLength) > maxBytes) rejectBeforeRead(413);
  }
  if (!request.body) throw new RequestBodyError(400);

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body.getReader();
    const bytes = new Uint8Array(maxBytes);
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - length) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyError(413);
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400);
  } finally {
    reader?.releaseLock();
  }
}
