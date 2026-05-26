import * as QRCode from 'qrcode';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('qrcode', () => ({
  toString: vi.fn(),
}));

describe('GET /api/qrcode', () => {
  beforeEach(() => {
    vi.mocked(QRCode.toString as unknown as () => Promise<string>).mockResolvedValue('<svg>QR</svg>');
  });

  it('returns an SVG QR code for the provided value', async () => {
    const response = await GET(new Request('http://localhost/api/qrcode?value=S001'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('image/svg+xml');
    await expect(response.text()).resolves.toBe('<svg>QR</svg>');
    expect(QRCode.toString).toHaveBeenCalledWith('S001', expect.objectContaining({ type: 'svg' }));
  });

  it('rejects missing QR values', async () => {
    const response = await GET(new Request('http://localhost/api/qrcode'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'QR 값을 입력해 주세요.' });
  });
});
