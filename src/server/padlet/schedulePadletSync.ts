import 'server-only';

import { after } from 'next/server';
import type { ConfiguredPadlet } from '@/server/repositories/configuredPadlet';

/** Capture the authorized tenant-bound adapter in the request, before its context ends. */
export function schedulePadletSync(padlet: ConfiguredPadlet, source: 'teacher' | 'student'): void {
  after(async () => {
    try {
      await padlet.syncIfStale(undefined, source);
    } catch {
      // Do not log exception bodies: upstream errors can contain private addresses or data.
      console.error('[padlet] background sync failed', { source });
    }
  });
}
