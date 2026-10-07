import 'server-only';
import { verifyLocalCapturedSourceCoverage, type CapturedSourceCoverageInput } from './localCapturedSourceCoverage';
import { canonicalId, canonicalJson, safeInteger, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type RejectionStage = 'INPUT_BOUNDARY' | 'POINTER_BOUNDARY' | 'STUDENT_PROJECTION';

/** Fixed diagnostic stages, not raw upstream errors or operational receipts. */
export class LocalCapturedStudentProjectionError extends Error {
  constructor(readonly stage: RejectionStage) {
    super(`Captured student projection ${stage} refused.`);
    this.name = 'LocalCapturedStudentProjectionError';
  }
}

/** Pure, opt-in inspection of ONE sanitized capture/manifest pair. No normalizer,
 * importer, DB, writer, clock, callback or caller-supplied expected projection.
 * The denominator and expected values come ONLY from captured Students.cells.
 * This is NOT a verifier of live acquisition, manifest provenance, original DB
 * state, final import, external exclusion or complete business reconciliation.
 * In particular the manifest's semantic fingerprint is NOT recomputed here.
 * Existing stage/wrapper callers are unchanged; this adds NO transaction gate.
 *
 * First reuse the actual pointer checker for descriptor, digest, schema,
 * tenant/job and raw pointer binding. Its bounded admission runs before any
 * local property read, trim, canonical encoding, map or expected-row allocation.
 * All input occurrences (including unrelated families) retain that boundary's
 * caps: 100k nodes, 1MB key/string UTF-8, 8192 UTF-16 units/string, 4096 array
 * elements, 256 object keys, depth 24, 4000 source units/source references.
 * Proxies/accessors/cycles/sparse arrays are rejected without user-code calls.
 * Native ownKeys allocation is not streaming admission or a hard heap/time bound.
 *
 * After admission this is synchronous, with no external mutation/await gap.
 * Expected maps are linear in bounded Students rows; there are two target and
 * two mapping entries and one source entry per row. Comparisons consume entries
 * exactly once: duplicates are rejected, never erased by Set deduplication.
 * Canonical encoding scratch is bounded by the admitted graph/text; success
 * diagnostics are empty and refusals disclose only the fixed boundary stage.
 * Neither inputs nor any objects reachable from them are modified/frozen.
 *
 * Deliberately conservative supported slice: schema 1/2/3's four Students
 * headers, unique after trim and in any order, with no unreviewed extra column;
 * ACTIVE/INACTIVE, trimmed nonempty id/name, canonical safe-integer balance.
 * The existing scalar validators alone are reused. No date/Unicode coercion,
 * regenerated IDs, balance-history inference or normalizer-output oracle.
 * Duplicate raw identities, ambiguous hash mappings and warned Students fail
 * closed. Unrelated families are pointer-accounted, NOT projection-validated.
 * Observed-empty Students may have absent/empty normalized arrays, but a missing
 * required Students tab is an input error, never evidence of an empty source.
 */
export function verifyLocalCapturedStudentProjection(raw: unknown) {
  let pointers: ReturnType<typeof verifyLocalCapturedSourceCoverage>;
  try { pointers = verifyLocalCapturedSourceCoverage(raw); }
  catch { throw new LocalCapturedStudentProjectionError('INPUT_BOUNDARY'); }
  if (pointers.status !== 'CAPTURE_POINTERS_ACCOUNTED' || pointers.pointerAccounting !== 'ACCOUNTED'
    || pointers.normalizationStatus !== 'READY_FOR_IMPORT') {
    throw new LocalCapturedStudentProjectionError('POINTER_BOUNDARY');
  }
  try {
    // Safe only after the real descriptor/content/pointer boundary above.
    const { capture, manifest } = raw as CapturedSourceCoverageInput;
    const tab = capture.sheets.tabs.Students;
    const headers = tab.headers.map((header) => header.trim());
    const required = ['studentId', 'name', 'balance', 'status'];
    if (headers.length !== required.length || required.some((name) => headers.filter((header) => header === name).length !== 1)) refuse();
    const positions = required.map((name) => headers.indexOf(name));
    const students = new Map<string, string>(), accounts = new Map<string, string>();
    const sources = new Map<string, string>(), mappings = new Map<string, string>();
    const rawHashes = new Set<string>();
    for (const row of tab.rows) {
      // Row/hash/width/number were validated against the actual sanitized capture.
      const [rawId, name, rawBalance, status] = positions.map((position) => row.cells[position].trim());
      const id = canonicalId(rawId), balance = safeInteger(rawBalance);
      if (!id || !name || balance === null || (status !== 'ACTIVE' && status !== 'INACTIVE')
        || students.has(id) || rawHashes.has(row.hash)) refuse();
      rawHashes.add(row.hash);
      const source = { kind: 'SHEET', artifactDigest: capture.sheets.digest, tab: 'Students', rowNumber: row.rowNumber, rowHash: row.hash };
      students.set(id, canonicalJson({ tenantId: capture.tenantId, studentId: id, name, status }));
      accounts.set(id, canonicalJson({ tenantId: capture.tenantId, studentId: id, balance }));
      sources.set(canonicalJson(source), canonicalJson({ source,
        redactedSourceRecord: { identityDigest: sha256(rawId), recognizedFieldCount: 4, omittedFieldCount: 0 },
        canonicalRecord: { studentId: id, name, balance, status }, mappingStatus: 'STAGED',
        targetTable: 'students', targetId: id, warningCodes: [], errorCodes: [] }));
      for (const targetTable of ['students', 'accounts']) {
        const key = canonicalJson({ sourceDigest: row.hash, targetTable, targetId: id, status: 'STAGED' });
        mappings.set(key, key);
      }
    }
    const expectedSourceUnits = tab.rows.length;
    const checkTargets = (table: 'students' | 'accounts', expected: Map<string, string>) => {
      const rows = Object.hasOwn(manifest.records, table) ? manifest.records[table] : [];
      if (rows.length !== expectedSourceUnits) refuse();
      for (const row of rows) {
        if (typeof row.studentId !== 'string') refuse();
        consume(expected, row.studentId, row);
      }
      if (expected.size) refuse();
      return rows.length;
    };
    const studentRows = checkTargets('students', students);
    const accountRows = checkTargets('accounts', accounts);
    let sourceRecordReferences = 0, mappingReferences = 0;
    for (const record of manifest.sourceRecords) {
      if (record.source.kind === 'SHEET' && record.source.tab === 'Students') {
        consume(sources, canonicalJson(record.source), record); sourceRecordReferences++;
      } else if (record.targetTable === 'students' || record.targetTable === 'accounts') refuse();
    }
    if (sources.size) refuse();
    for (const mapping of manifest.mappings) {
      // Also catches a Student hash redirected to some unrelated table. A
      // cross-tab hash ambiguity is conservatively refused, never attributed.
      if (rawHashes.has(mapping.sourceDigest) || mapping.targetTable === 'students' || mapping.targetTable === 'accounts') {
        consume(mappings, canonicalJson(mapping), mapping); mappingReferences++;
      }
    }
    if (mappings.size) refuse();
    return deepFreeze({ scope: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTING_ONLY' as const,
      status: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTED' as const,
      authority: 'NONAUTHORITY' as const, complete: false as const, activationAllowed: false as const,
      exclusion: 'NOT_PROVEN' as const, fullSourceReconciliation: 'NOT_PERFORMED' as const,
      fullTargetReconciliation: 'NOT_PERFORMED' as const, preRedactionInventory: 'NOT_OBSERVED' as const,
      canonicalBusinessValidation: 'NOT_PERFORMED' as const, contributorMultiplicityValidation: 'STUDENTS_ONLY' as const,
      binding: 'CONTENT_DIGESTS_ONLY' as const, sourceAuthenticity: 'NOT_PROVEN' as const,
      semanticFingerprintValidation: 'NOT_PERFORMED' as const,
      presence: expectedSourceUnits ? 'PRESENT_NONEMPTY' as const : 'PRESENT_EMPTY' as const,
      expectedSourceUnits, sourceRecordReferences, studentRows, accountRows, mappingReferences,
      diagnostics: [] as readonly never[], omittedDiagnostics: 0 });
  } catch { return refuse(); }
}

function consume(expected: Map<string, string>, key: string, actual: unknown): void {
  if (!expected.has(key) || expected.get(key) !== canonicalJson(actual)) refuse();
  expected.delete(key);
}
function refuse(): never { throw new LocalCapturedStudentProjectionError('STUDENT_PROJECTION'); }
