# Task19 synthetic sealed preactivation preparation

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

NONPRODUCTION, NONAUTHORITY, no activation or pointer mutation. This is a bounded
executable preparation extension, not operational Task19 acceptance.

## Contract mismatch and smallest safe extension

`stageLegacyFinalGeneration` / `stageLocalFullGeneration` require the original
import's READY job, original acquired Sheets/Redis snapshots, original importer
readback and immutable retained generation graph. The Task21 cold destination is
an IMPORTING/v2 materialized domain restored from native PG, with subsequent
product SQL writes. It is neither that original importer graph nor the READY
source. The original staged synthetic DB is already deleted; operational original
access is forbidden. Calling the old preparer would reject. Forging READY,
rewriting the original captures or accepting stale pre-write readback would weaken
its contract. None is done.

`stageLocalSealedPreactivation` is the narrow sibling entry point in migration:
it consumes the existing independently pinned Task21 protocol, performs actual
SQL reconciliation, then atomically creates a private, immutable preparation.
No original preparation, importer, SQL migration, lifecycle, runtime grant, HTTP
route or operational activation contract is changed. Old unsealed/single-segment
APIs remain separate and cannot produce this sealed preparation.

## Trust and transaction boundary

The trusted launcher supplies separately retained base/chain identities and a
still-owned synthetic coordinator handle + owner/system pin. Segment transport
cannot select the coordinator, endpoint or seal. All database handles are freshly
owned isolated disposable PG; no ambient URL/default transaction runner exists.
Physical identities are re-inspected. Under coordinator then destination locks,
the gate reads and validates coordinator lease/public state/seal, exact installed
seal, destination restore lease/receipt, every sealed journal entry and terminal
cardinality. Missing suffixes, absent/conflicting seals, wrong identities or any
public row/sequence/guard mismatch reject before preparation DDL/DML.

It also recomputes every product before/after transition from the admitted base,
checking each segment's final products independently. A coherent digest/checkpoint
shell alone is insufficient. The readback includes all public rows (four existing
provenance exceptions have separate exact identity/emptiness checks), sequences
and public schema guards. No unchecked caller-supplied MATCH receipt is accepted.

Only after all checks does it append
`local_restore_control.sealed_preactivation`. Existing conflicting preparations
reject rather than repair. Cold APPLICATION-process retries re-read all current
SQL and return the same preparation. A previous preparation cannot mask later
drift. The row is owner-only and update/delete/truncate guarded; it is not an
activation, approval, writer-fence or authority receipt.

## Validation evidence and limits

Tests retain raw public/private SQL wire rows plus xmin/ctid, sequence state,
guards/functions/privileges before and after rejects. The owner-only fault setup
and explicit restoration are outside the measured rejection boundary and are not
represented as rollback proof. Exact witness files are content-addressed and
indexed in child receipts. Source is deleted before destination restore; the gate
checks the separately retained sealed source chain, not a fabricated live-source
query. Cold gate invocation and retry run in different application processes.

Completeness is ONLY relative to the declared controlled synthetic product writer
and its terminal intent. Outside writer/CDC coverage, global ordering, other
entities, operational exclusion and malicious SQL superuser resistance are not
proven. Private fixture SQL locks are not an operational writer fence. Coordinator
and destination are not a distributed commit; ambiguous return after destination
commit requires revalidation by retry, never inferred rollback. There is no claim
of PG/host/power-loss durability or permanent coordinator key transport.

See dispatch `task19-synthetic-sealed-preactivation-gate-20260927/FINAL-HANDOFF.md`
for exact RED/GREEN receipts, final manifest, changed hashes, cleanup and limits.
Whole Vitest historical exit130, browser availability, full Task19–24 and
operational acceptance remain unproven. Independent Sol verification is separate.
