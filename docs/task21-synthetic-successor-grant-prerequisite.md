# Task21 successor grant: immutable-private-state prerequisite

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

Scope: controlled source-owned synthetic sealed export -> fresh launcher-owned disposable PostgreSQL only. This packet does NOT enroll or accept a successor.

## Concrete blocker

The preceding borrowed-handle denial tests used a process without an enrolled replay capability. They did not independently prove private SQL guard admission: absence of original replay/settlement authority masked that prerequisite.

A new behavioral RED runs with a genuinely authorized original execution after committed checkpoint 1 and, separately, a normally SUCCEEDED original with complete SQL. Disabling the private checkpoint `immutable` trigger without changing a single row still returned `ALREADY_APPLIED` and `SEALED_TERMINAL_VERIFIED`, respectively. Exact before/after public/private SQL witnesses were equal. Thus correct row hashes and a valid execution pin did not establish immutable original checkpoint evidence.

Stop disposition: do not issue a durable successor grant on this invariant. The authorized narrow fallback adds executable private-immutability admission, not an authority reconstruction from serialized pins. Original ColdLease, WeakMaps, death proof, quarantine and settlement contracts remain unchanged.

## Narrow implemented boundary

Every existing private terminal-record read and chain journal read checks both required native triggers and their referenced function, inside its existing transaction. Destination lease reads use the same check. Exact checks cover trigger name/enabled mode/event/timing/row semantics/columns/condition/arguments/function identity and the fixed immutable function source, language, return signature, owner and execution attributes. A relation SHARE lock retains trigger-DDL exclusion through the caller transaction. Unknown additional user triggers fail closed. Replica execution mode is rejected.

The shared checks cover source intent/terminal/outbox, independent coordinator lease/seal, destination lease/terminal/execution/checkpoint and preparation retry. No schema migration, guard repair, new lease, successor API, replay permission, authority change or ACTIVE write is introduced. Rejection does not repair disabled guards or write preparation. Positive original replay/settlement and cold preparation retries remain distinct.

## Explicit limits / next eligible NONPRODUCTION functionality

This fixes observed private-trigger/function divergence admission. It does not certify the entire private schema/ACL/constraint catalog as a successor trust root. Relation locks do not fence concurrent privileged `CREATE OR REPLACE FUNCTION`, nor establish a durable independently pinned guard baseline. Same-UID/SQL-owner compromise and coordinator/host loss remain outside this controlled fixture's trust model.

The focused suite also contains an explicit missing-capability characterization: while connection A retains a native lease SHARE lock and a live transaction after successful guard admission, connection B commits replacement of the immutable function. Native backend/lock records distinguish this from process death. Revalidation detects the drift, but the previous successful check is not a transaction-lifetime fence; a no-op UPDATE can execute until A rolls it back. Exact row/xmin/ctid and full witnesses are restored, and no grant is enrolled. This characterization is not a successor acceptance or an implementation of the missing fence.

Next eligible functionality: source-owned enrollment of an immutable original guard/catalog baseline with a tested native transaction fence (including function-definition replacement and schema/ACL/constraint drift), pinned independently to the original coordinator/terminal before original replay. Exercise native two-connection DDL contention and exact public/private witnesses. Only after that prerequisite can a separately enrolled successor grant/atomic consume-checkpoint protocol be implemented; never upgrade the original serialized execution pin or copied ColdLease. Keep terminal and preparation proof separately gated.

No accepted successor, exactly-once successor suffix, or before-/after-COMMIT/receipt successor-death acceptance is claimed. Existing cold-death regressions remain denial-only. Full Vitest historical exit130, browser/real restore and Task19–24 whole acceptance remain distinct and unclosed.
