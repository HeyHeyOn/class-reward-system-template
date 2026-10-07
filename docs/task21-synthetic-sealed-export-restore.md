# Task21 synthetic sealed export / cold recovery bridge

> **과거 실험 기록:** Task1–24 계획에 속한 당시의 합성 검증·복구 실험이다. 현행 A–F의 실행 순서나 현재 운영 완료율을 나타내지 않는다. 현재 상태는 [README](../README.md)를 따른다.

NONPRODUCTION only. This is an executable local data handoff, not backup/restore
of operational data, not ACTIVE, and not operational Task19–24 acceptance.

## Entrypoints and authority

`src/server/exports/syntheticSealedExport.ts` exposes three internal server-only
functions. `exportSealedProductRecovery` accepts the owned source, original cold
archive anchor, separately pinned base/chain and independent terminal coordinator.
It emits only `{sha256}`; the fixed content address is
`.sealed-product-export/<sha256>.json` under the fixture CWD. There is no supplied
path, URL, ambient DB configuration, HTTP route or uploaded coordinator authority.

The canonical envelope contains the exact prewrite native SQL archive, its full
materialized expectation/provenance, the committed multisegment outbox payloads
and request digests, declared terminal intent and all sealed endpoints, independent
coordinator pin, and exact postwrite public SQL/sequence/guard witnesses. The
export checks the original cold gate read-only, then locks coordinator before
source, validates independent seal/intent/outbox continuity, and reconciles every
product before/after transition and each intermediate final image. A valid prefix
or coherently rehashed impossible intermediate image cannot export.

`restoreSealedProductExport` validates the entire envelope before allocation. It
executes the envelope's archive bytes through `acquireColdArchiveFromExport`,
which uses the SAME original cold anchor, authentication, lock, expiry, journal,
attempt/allocation inventory and lease state machine as ordinary cold restore.
The original transport SQL file can be absent; the coordinator control directory
cannot. There is NO second enrollment, cloned coordinator, recreated READY,
lease reset, or changed original capture/version. A second restore attempt after
success rejects. Raw native SQL is executable only because its exact digest was
already trusted by that retained original archive coordinator.

The bridge creates an owned disposable destination, restores the original base,
installs the independently retained terminal and replays all sealed segments.
It returns `RESTORED_AWAITING_SEALED_PREPARATION`, not a complete recovery receipt.
Successful target cleanup belongs to the caller. Failures after acquisition are
QUARANTINED, never reset to READY, and the exact owned target is closed. Baseline
and segment commits are separate monotonic boundaries, not one all-or-nothing
restore transaction. Process/host crash recovery of this composition is not proven.

`prepareSealedProductExport` reopens the pinned envelope and independent coordinator
in a cold APPLICATION process, then calls the Task19 sealed preparation gate. Its
additional export seal constraint is checked under the existing coordinator lock
held through destination validation and the private preparation append. This can
only RESTRICT the old gate, never grant authority. Task19 recomputes the complete
product chain, validates current destination rows, sequences, guards, installed
seal and checkpoint cardinality before writing. Cold identical retry returns
ALREADY_PREPARED with exact unchanged public/private SQL witnesses. Drift rejects
without repair or a new accepted preparation receipt.

## Immutability, redaction and bounds

The artifact directory is owner-only 0700. Publication fsyncs an exclusive temp
file, changes it to 0400, links without replacement, removes the temp link and
fsyncs the directory. Repeated export compares the complete existing bytes;
corruption never triggers overwrite/repair. Reads reject symlinks, hardlinks,
wrong UID/mode, missing files, byte-length/digest/canonical-form mismatch, unknown
fields, malformed base64 and oversized envelopes. The separately retained digest
is trusted launcher input; a digest supplied alongside arbitrary uploaded bytes
would not be authority. Same-UID trusted host code can chmod/remove files: these
are immutable-by-protocol, NOT physical WORM or hostile-root tamper resistance.

Bounds: envelope 64 MB, original archive 16 MB, existing segment codec 1 MB each,
at most 32 declared segments, at most 100 events per segment and at most 1000
products. Existing safe-integer product codec is unchanged. Full public SQL,
bigint/timestamp, sequences and guards remain PostgreSQL exact wire strings.

Redaction is structural exclusion, not arbitrary-data scrubbing: only synthetic
archive content previously admitted by the materialized archive contract and
allowlisted journal fields enter the artifact. No process/container evidence,
connection URL, filesystem locator, environment, credential or session row,
cold coordinator lease/authentication file is copied. Original empty unrelated
public tables must remain empty (owner COUNT before full row read); unexpected
public tables reject. Source/restore provenance UUIDs and hashes ARE retained for
binding. The native archive includes schema definitions for empty sensitive tables,
not credential values. This is NOT a generic secret/PII classifier for arbitrary
free-text product names or metadata. Only generated controlled synthetic sources
are supported; no real data was accessed or permitted. Synthetic secret canaries,
unknown fields and source schema/data divergence are rejection tests.

## Why this is intentionally a narrow bridge

The retained native base archive does not include later owner-only product outbox
or terminal tables. Re-exporting current PG wholesale would mix source ownership,
restore authority and sensitive/private state. This bridge instead transports the
original admitted base plus the exact controlled journal/seal and composes the
existing admission gates. The destination's source materialization ownership rows
remain empty and its restoration provenance is independently verified, not copied.

Source DB and its original transport SQL are deleted before restore, but the
original trusted cold control files, terminal coordinator and independent pins
remain necessary. Self-contained transport of authority, relocation to an
untrusted host, recreation after loss of coordinator state, multi-consumer restore,
PG/host/power-loss durability and restart of interrupted partial replay are NOT
implemented. These gaps must not be hidden by another enrolled coordinator.

The Task19 original READY/importer/capture contract still cannot consume an
IMPORTING postwrite destination. This bridge produces only its existing sibling
`LOCAL_SEALED_PREACTIVATION_PREPARATION_ONLY` result, with NONAUTHORITY,
activationAllowed=false, complete=false, CONTROLLED_SYNTHETIC_PRODUCT_WRITER_ONLY
and outsideWriterCoverage=NOT_PROVEN. Source writer fencing/CDC, outside writers,
other entities, global ordering and operational exclusion remain unproven.

## Execution evidence

Owned-PG positive/negative tests run via the unchanged stage runner, serially in
fresh frozen fixtures under no-egress bwrap and independent class-store systemd
units. Nested cold children use default+JSON reports. Tests compare exact public
and private SQL rows (including xmin/ctid), sequence and guard/function/privilege
witnesses on rejects; fault injection/restoration occurs OUTSIDE measured calls.
The test source is actually removed before destination creation. The original
transport file is removed too, proving that restored bytes came from the envelope.

See dispatch `task21-synthetic-sealed-export-restore-20260927/FINAL-HANDOFF.md`
for final source manifest/hashes, RED/GREEN receipts, artifact handles and cleanup.
Full Vitest's historical exit130, unavailable browser, operational Task19–24
acceptance and independent Sol verification remain separate/unproven here.
