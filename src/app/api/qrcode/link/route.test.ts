import * as QRCode from 'qrcode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

vi.mock('qrcode', () => ({ toString: vi.fn() }));

function post(body: unknown, contentType = 'application/json') {
  return new Request('http://localhost/api/qrcode/link', {
    method: 'POST', headers: { 'Content-Type': contentType }, body: JSON.stringify(body),
  });
}

describe('POST /api/qrcode/link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(QRCode.toString as unknown as () => Promise<string>).mockResolvedValue('<svg>link</svg>');
  });

  it.each(['https://example.com/', 'http://localhost:3000/admin'])('renders a canonical bounded web URL from an exact body: %s', async (url) => {
    const response = await POST(post({ kind: 'system-link', url }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(QRCode.toString).toHaveBeenCalledWith(url, expect.any(Object));
  });

  it.each([
    { kind: 'system-link', url: 'class-store-admin:secret' },
    { kind: 'system-link', url: 'javascript:alert(1)' },
    { kind: 'system-link', url: 'https://example.com' },
    { kind: 'system-link', url: 'https://user:pass@example.com/' },
    { kind: 'system-link', url: `https://example.com/${'a'.repeat(2048)}` },
    { kind: 'student', url: 'https://example.com/' },
    { kind: 'system-link', url: 'https://example.com/', extra: true },
  ])('rejects unsafe, credential-looking, noncanonical, oversized, or unknown bodies', async (body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('requires JSON', async () => {
    const response = await POST(post({ kind: 'system-link', url: 'https://example.com/' }, 'text/plain'));
    expect(response.status).toBe(400);
    expect(QRCode.toString).not.toHaveBeenCalled();
  });

  it('rejects every query-bearing POST before parsing the body', async () => {
    const request = new Request('http://localhost/api/qrcode/link?url=https%3A%2F%2Fexample.com%2F', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'system-link', url: 'https://example.com/' }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(QRCode.toString).not.toHaveBeenCalled();
  });
});
