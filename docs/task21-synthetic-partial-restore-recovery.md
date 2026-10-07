# Task21 synthetic partial sealed restore: cold-death disposition

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

NONPRODUCTION only. This closes the previously implicit application-death path
with an executable quarantine, not resumability or operational recovery.

## Entry point and invariants

`quarantineSealedProductExport(ref, originalAnchor, base, chainPin, coordinator,
coordinatorPin)` reopens the immutable sealed export, checks the exact base,
chain and independently retained terminal/coordinator, and holds the coordinator
lock through the original cold-store disposition. It cannot accept a destination
handle or a caller's SQL match assertion as replay authority.

The cold-store helper authenticates the original expectation, immutable attempt,
worker identity, launcher-observed SIGKILL receipt, surviving original lease lock,
and DISPATCHED allocation inventory. A live/unproved worker or damaged authority
is BLOCKED with an append-only diagnostic. Mismatched export/anchor/base/pins throw
without changing SQL or the cold journal. Confirmed death of the original
DISPATCHED worker durably publishes QUARANTINED and keeps the original lock.

Every returned result has `accepted: false`, `activationAllowed: false`,
`authority: NONAUTHORITY`, and `complete: false`. The private `recovery.json` is a
quarantine disposition, NOT an accepted recovery or preparation receipt. It says
SQL was NOT_ADOPTED and `rollbackVerified: false`. This path never enrolls a second
archive, reconstructs a WeakMap lease, deletes a database, resets READY, forges
source capture, or advances the tenant to ACTIVE.

A cold retry rechecks the immutable export/coordinator and certified death and
returns the identical durable disposition only when recovery.json and state.json
agree exactly. An interrupted/changed publication stays BLOCKED; it is not
repaired by rewriting READY. The database is intentionally retained untouched by
the implementation; only the separate test owner performs exact-ID cleanup.

## Why no resume

Existing lease and target capabilities live in process-local WeakMaps. Their
serialized cold-store records are not successor execution authority. No current
contract transfers those capabilities to a new application process. A matching
committed checkpoint, SQL rows, sequences or guards does not fill this gap.
This implementation deliberately does not adopt or resume either a clean or a
dirty partial database. A future resume contract must independently bind the
successor to the exact terminal/coordinator, committed prefix, destination SQL,
sequence and guard witnesses and durable execution/publication authority.

The original synthetic source authority and retained terminal coordinator remain
required. Loss of those pins/keys/host state is not solved here. There is no new
HTTP route, production recovery command, writer fence or operational completeness
claim.

## Executed test boundaries

`syntheticSealedCrash.postgres.test.ts` captures a real owned synthetic source,
closes it, restores a fresh owned PG from the sealed export and forces SIGKILL
of the actual application PID (Vitest threads keep the application in that PID).
The supervisor records both exit and close and certifies the observed termination;
a different cold application performs disposition, and another process retries.

- After commit: pause after segment one SQL COMMIT but before its replay result
  reaches the bridge. Independently read checkpoint/digest, rows, sequences,
  guards and full public/private witnesses before killing the application.
- During transaction: leave segment two product changes and its checkpoint
  inserted in an open transaction before COMMIT. Record the same transaction's
  backend/checkpoint/SQL, while an independent connection sees only committed
  segment one. After SIGKILL wait for that exact backend to disappear, then read
  exact SQL again. Only this observed transaction outcome establishes segment
  two's rollback; it does not rewind the archive's committed base/segment one.
- Wrong anchor/owner/base/chain/coordinator, artifact tamper, absent/false worker
  death, inventory owner/phase tamper, incomplete prefix, partial product SQL,
  sequence drift, and disabled RLS all deny recovery/preparation acceptance.
- All rejections record full before/after public/private witnesses including
  xmin/ctid, triggers, relations, functions and exact sequence state. Cold-store
  bytes are also compared. BLOCKED permits only its new diagnostic; successful
  quarantine retry permits no SQL or cold-store change.

Raw evidence lives only in a new frozen runner fixture: `.sealed-crash-results`,
`.product-terminal-results`, `.sealed-product-export`, and the existing
`.cold-restore-control`. No frozen evidence is rewritten. The current dispatch's
FINAL-HANDOFF records actual RED/GREEN commands, failures, receipts, manifests,
cleanup and remaining limits. Historical whole-suite Vitest exit130 and browser,
real restore, and Task19–24 product acceptance remain unproven.
