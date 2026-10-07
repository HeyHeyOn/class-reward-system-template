// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getVerifiedGoogleSourceControlClaims, verifyOperatorObservedGoogleSheetControl } from './googleSourceControl';
vi.mock('server-only', () => ({}));
const now = Date.now();
const session = { subject: 'provider-subject', email: 'owner@example.invalid', issuedAt: now };
const observation = { method: 'OPERATOR_GOOGLE_SHARE_UI', observedAt: now, fileId: 'sheet',
  googleSubject: session.subject, ownerEmail: session.email, ownerIsSignedInUser: true,
  role: 'OWNER', generalAccess: 'RESTRICTED', listedPrincipals: 1,
  providerSpreadsheetReadSucceeded: true, evidenceDigest: 'a'.repeat(64) };
const verify = (overrides = {}) => verifyOperatorObservedGoogleSheetControl({ fileId: 'sheet', session,
  readObservation: async () => ({ ...observation, ...overrides }), now: () => now });
describe('trusted operator Google sharing observation', () => {
  it('mints a source-bound capability with explicit UI provenance, without claiming Drive API verification', async () => {
    const proof = await verify();
    expect(getVerifiedGoogleSourceControlClaims(proof)).toEqual({ externalSourceId: 'sheet', googleSubject: session.subject,
      googleEmail: session.email, role: 'OWNER', verifiedAt: new Date(now).toISOString(),
      verificationMethod: 'OPERATOR_GOOGLE_SHARE_UI', evidenceDigest: 'a'.repeat(64) });
    expect(() => getVerifiedGoogleSourceControlClaims({ ...proof })).toThrow(/capability/);
  });
  it.each([
    { fileId: 'other' }, { googleSubject: 'other' }, { ownerEmail: 'other@example.invalid' },
    { ownerIsSignedInUser: false }, { role: 'EDITOR' }, { generalAccess: 'ANYONE' },
    { listedPrincipals: 2 }, { providerSpreadsheetReadSucceeded: false },
    { observedAt: now - 300_001 }, { observedAt: now + 1 }, { method: 'CLIENT_ASSERTION' }, { evidenceDigest: '' },
  ])('rejects incomplete, stale or mismatched evidence %o', async overrides => {
    await expect(verify(overrides)).rejects.toThrow(/sharing observation/);
  });
  it('requires a fresh provider identity even when the UI observation is fresh', async () => {
    await expect(verifyOperatorObservedGoogleSheetControl({ fileId: 'sheet', session: { ...session, issuedAt: now - 300_001 },
      readObservation: async () => observation, now: () => now })).rejects.toThrow(/identity/);
  });
});
