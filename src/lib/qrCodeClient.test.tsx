import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQrObjectUrls, type QrBlobRequest } from './qrCodeClient';

const request: QrBlobRequest = {
  key: 'student-S001',
  endpoint: '/api/qrcode',
  body: { kind: 'student', studentId: 'S001' },
};

function Harness({ requests = [request] }: { requests?: readonly QrBlobRequest[] }) {
  const urls = useQrObjectUrls(requests);
  const value = urls[request.key];
  return <span>{value === undefined ? 'pending' : value === null ? 'failed' : value}</span>;
}

describe('useQrObjectUrls response validation', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:valid-qr'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['JSON', new Response('{"error":"not svg"}', { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['HTML', new Response('<html>not svg</html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })],
    ['an empty SVG blob', new Response('', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } })],
    ['an SVG response with another parameter', new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml; profile=test' } })],
  ])('records failure and creates no object URL for 2xx %s', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn(async () => response));

    render(<Harness />);

    expect(await screen.findByText('failed')).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('accepts a nonempty SVG response with a valid charset parameter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg/>', {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml; charset=UTF-8' },
    })));

    render(<Harness />);

    await waitFor(() => expect(screen.getByText('blob:valid-qr')).toBeTruthy());
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('keeps a repeated request pending after its previous object URL was revoked', async () => {
    const responseResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      responseResolvers.push(resolve);
    })));
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce('blob:first-qr')
      .mockReturnValueOnce('blob:fresh-qr');

    const { rerender } = render(<Harness requests={[request]} />);
    await waitFor(() => expect(responseResolvers).toHaveLength(1));
    await act(async () => {
      responseResolvers[0](new Response('<svg/>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      }));
    });
    expect(screen.getByText('blob:first-qr')).toBeTruthy();

    rerender(<Harness requests={[]} />);
    expect(screen.getByText('pending')).toBeTruthy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-qr');

    rerender(<Harness requests={[request]} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText('pending')).toBeTruthy();

    await act(async () => {
      responseResolvers[1](new Response('<svg/>', {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml' },
      }));
    });
    expect(screen.getByText('blob:fresh-qr')).toBeTruthy();
  });
});
