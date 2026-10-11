// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readBoundedRequestText, RequestBodyError } from './boundedRequestBody';
import { readClassTreeJson } from './classTreeHttp';
import { readPetJson } from './petHttp';

vi.mock('server-only', () => ({}));

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}, pendingCancel = false) {
  let position = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (position < chunks.length) controller.enqueue(chunks[position++]);
    else controller.close();
  });
  const cancel = vi.fn(() => pendingCancel ? new Promise<void>(() => {}) : undefined);
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  const request = new Request('https://example.invalid/api/example', {
    method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { request, pull, cancel };
}
const encode = (value: string) => new TextEncoder().encode(value);

describe('bounded request body', () => {
  it('decodes UTF-8 split between chunks at the exact byte limit', async () => {
    const bytes = encode('한글');
    const { request } = streamed([bytes.slice(0, 1), bytes.slice(1, 4), bytes.slice(4)]);
    await expect(readBoundedRequestText(request, 6)).resolves.toBe('한글');
  });

  it.each<Record<string, string>>([{}, { 'content-length': '1' }])('bounds actual streamed bytes independently of declared length %j', async (headers) => {
    const { request, pull, cancel } = streamed([encode('123'), encode('456'), encode('never read')], headers, true);
    await expect(readBoundedRequestText(request, 5)).rejects.toMatchObject({ status: 413 });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  }, 1_000);

  it.each([
    [{ 'content-encoding': 'gzip' }, 400],
    [{ 'content-encoding': 'identity' }, 400],
    [{ 'content-length': '-1' }, 400],
    [{ 'content-length': '3.5' }, 400],
    [{ 'content-length': '1, 2' }, 400],
    [{ 'content-length': '100000000000000000000000000000000000' }, 413],
  ] as const)('rejects unsupported headers before reading %j', async (headers, status) => {
    const { request, pull, cancel } = streamed([encode('{}')], headers, true);
    await expect(readBoundedRequestText(request, 8)).rejects.toMatchObject({ status });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  }, 1_000);

  it('rejects malformed UTF-8 and unavailable bodies as a client error', async () => {
    await expect(readBoundedRequestText(streamed([new Uint8Array([0xc3, 0x28])]).request, 8)).rejects.toMatchObject({ status: 400 });
    await expect(readBoundedRequestText(new Request('https://example.invalid'), 8)).rejects.toBeInstanceOf(RequestBodyError);
    const request = streamed([encode('{}')]).request;
    await request.text();
    await expect(readBoundedRequestText(request, 8)).rejects.toMatchObject({ status: 400 });
  });

  it('maps an interrupted stream to a client error', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST', body: new ReadableStream({ pull: (controller) => controller.error(new Error('synthetic disconnect')) }), duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBoundedRequestText(request, 8)).rejects.toMatchObject({ status: 400 });
  });
});

describe.each([
  ['pet', readPetJson, 20_000], ['class tree', readClassTreeJson, 10_000],
] as const)('%s JSON body reader', (_name, readJson, limit) => {
  it('returns JSON objects and rejects arrays, invalid encoding and oversized bytes', async () => {
    await expect(readJson(streamed([encode('{"name":"한글"}')]).request)).resolves.toEqual({ value: { name: '한글' } });
    for (const chunks of [[encode('[]')], [new Uint8Array([0xff])]]) {
      const response = await readJson(streamed(chunks).request);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
    }
    const large = encode(JSON.stringify({ name: '한'.repeat(Math.ceil(limit / 3)) }));
    const { request, cancel } = streamed([large], {}, true);
    const response = await readJson(request);
    expect((response as Response).status).toBe(413);
    expect((response as Response).headers.get('cache-control')).toBe('no-store');
    expect(cancel).toHaveBeenCalledOnce();
  }, 1_000);
});
