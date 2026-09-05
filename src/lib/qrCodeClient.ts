'use client';

import { useEffect, useMemo, useState } from 'react';

type QrBody =
  | Readonly<{ kind: 'student'; studentId: string }>
  | Readonly<{ kind: 'admin'; password: string }>
  | Readonly<{ kind: 'system-link'; url: string }>;

export type QrBlobRequest = Readonly<{
  key: string;
  endpoint: string;
  body: QrBody;
}>;

const SVG_CONTENT_TYPE = /^image\/svg\+xml(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t !#-\[\]-~]|\\[\t !-~])*"))?\s*$/i;

function isSvgContentType(value: string | null): boolean {
  return value !== null && SVG_CONTENT_TYPE.test(value);
}

export function useQrObjectUrls(requests: readonly QrBlobRequest[]): Readonly<Record<string, string | null | undefined>> {
  const serialized = JSON.stringify(requests);
  const stableRequests = useMemo(() => JSON.parse(serialized) as QrBlobRequest[], [serialized]);
  const requestIdentity = useMemo(() => Symbol(serialized), [serialized]);
  const [urlState, setUrlState] = useState<Readonly<{
    requestIdentity: symbol;
    values: Readonly<Record<string, string | null | undefined>>;
  }>>({ requestIdentity, values: {} });

  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    let active = true;
    for (const request of stableRequests) {
      void fetch(request.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error('QR generation failed');
        if (!isSvgContentType(response.headers.get('Content-Type'))) throw new Error('Invalid QR content type');
        const blob = await response.blob();
        if (blob.size === 0 || !isSvgContentType(blob.type)) throw new Error('Invalid QR blob');
        const objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        created.push(objectUrl);
        setUrlState((current) => ({
          requestIdentity,
          values: {
            ...(current.requestIdentity === requestIdentity ? current.values : {}),
            [request.key]: objectUrl,
          },
        }));
      }).catch(() => {
        if (active) {
          setUrlState((current) => ({
            requestIdentity,
            values: {
              ...(current.requestIdentity === requestIdentity ? current.values : {}),
              [request.key]: null,
            },
          }));
        }
      });
    }

    return () => {
      active = false;
      controller.abort();
      for (const objectUrl of created) URL.revokeObjectURL(objectUrl);
    };
  }, [serialized, stableRequests, requestIdentity]);

  return urlState.requestIdentity === requestIdentity ? urlState.values : {};
}

export function useQrObjectUrl(request: QrBlobRequest | null): string | null | undefined {
  const requests = useMemo(() => request ? [request] : [], [request]);
  const urls = useQrObjectUrls(requests);
  return request ? urls[request.key] : undefined;
}
