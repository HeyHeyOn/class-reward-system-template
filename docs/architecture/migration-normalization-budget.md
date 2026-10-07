# Legacy normalization budget: integration foundation (P0 INCOMPLETE)

**Not a completed P0 implementation. Do not start P1 or treat normalization as
bounded on the strength of these modules.** Normalizer, manifest construction,
importer and capture callsites remain unbounded by this request budget. The real
normalizer now accepts a trailing context for entry admission, aggregate row caps,
header/row callers, cell coercion, nested transaction item parsing/validation,
the SHEET Entry shell, accepted transaction item loop/ref/ID construction,
normal transaction final/student-ref and staged item/Target construction,
cancellation scalar/status/canonical/ref/staged construction, student/product/
promotion definition canonical/ref/staged construction, Tasks canonical/ref/ID/staged
construction, TaskAssignments/TaskCompletions closed construction, and final-output
categories. Its remaining
canonical allocations, joins and work guards are still incomplete. Final-output
category caps are implemented at the emission seams described below.
`validators.ts` now has opt-in structural and snapshot business
validation, serialization, hash/ID and mutable-clone seams. The READY preparation
change remains callback compatibility only.
There is deliberately no budget-enabled manifest-construction API yet.

The approved P0 contract is based on HEAD
`448cbed7bd303ad0f9ef3fd4c974c313bf4c8da8`. It requires guards throughout the actual
reachable implementation, not an alternate normalizer or a post-result check.
The following leaf primitives are executable and tested, but are only part of
that prerequisite.

## Implemented primitives

- `src/lib/boundedWork.ts`: dependency-free request-owned cumulative reservations,
  safe integer/overflow checking, atomic multi-counter admission, work counters,
  depth checks, single-string reservation, cooperative monotonic deadline and
  cancellation, lazy allocation boundary, UTF-8 measurement without encoding,
  stable merge sort with pre-reserved output/scratch and charged comparisons and
  moves. There are no resets/refunds; separate calls can share one context.
- `src/lib/boundedJson.ts`: iterative lexical/grammar scanner with fixed depth
  scratch; checks decoded string/key byte counts, duplicate property occurrences,
  node/slot/structural counts, grammar and depth before native `JSON.parse`.
  Parsed graph allocation and native parse work are reserved before the call.
  Native errors are replaced by a fixed error; budget errors propagate unchanged.
  The post-native deadline check discards a late result, not interrupts parsing.
- Existing `parseBoundedJson` remains lexical-only and returns `unknown`; its
  scanner and allocation semantics are preserved. New `parseRegisteredBoundedJson`
  consumes its own private lexical ticket, reserves descriptor/key/index-string
  scratch before enumeration, rejects poison keys/accessors/exotic prototypes and
  nonfinite numbers, then freezes each container and stores request-owned private
  shape metadata. No object-registration function accepts caller JSON or a claimed
  arity. Unregistered objects (including proxies) fail before traps/enumeration.
- The new decoder conservatively uses the ticket's maximum arity at every first
  container enumeration; this can refuse smaller graphs sooner than exact per-node
  recipes. Native `JSON.parse` and JavaScript intrinsics remain trusted runtime
  boundaries, not a sandbox for malicious monkey-patches. Freeze prevents stale
  certificates after caller mutation. Admission is NOT authenticity/business shape.
- `canonicalBoundedJson` measures exact escaped bytes in a charged first pass,
  atomically reserves the final buffer and decoded string copy, then emits into
  that buffer. Both passes preserve sorted code-unit keys, array order, scalar
  JSON semantics, escaping and surrogate behavior. Complete caps 8,000,000 and
  524,288 are exercised at minus-one/exact/plus-one. Number formatting uses bounded
  32-byte scratch; string values are never first stringified into oversized text.
- `cloneFreezeBoundedJson` is an explicitly combined detached clone/freeze operation
  on registered immutable data. It reserves each container/scalar occurrence and
  sidecar before creation; shared strings and immutable key arrays are references.
  It is deliberately NOT wired as the existing mutable `clonePlainData` default.
- `createBoundedProjection` has closed, typed `sheetsArtifact`/`redisArtifact`
  recipes. It reserves the fixed schema, scalar-reference upper bound and private
  sidecar before invoking a lazy registered-source operand or constructing the
  result. Field-name arrays are immutable program constants, never caller arity
  claims. It emits frozen registered projections sharing admitted descendants;
  no native key enumeration or arbitrary-object registration is exposed.
- `assertNormalizationInput(value, budget?)` and `canonicalJson(value, budget?)`
  retain structural traversal and canonical writer dispatch. The optional
  `assertManifestInputShape(value, budget?)` now carries the SAME context through
  complete Sheets/Redis shape, Settings credential extraction, row/artifact and
  tuple/binding hashes, private indexes and nested visits. Registered immutable
  key views avoid `Object.keys` scratch. Settings budget mode uses two scalar
  extraction slots with original last-key-wins semantics, not a dynamic object.
- `sha256`, `compareCodeUnits`, scalar ID/integer/decimal/boolean/instant/digest
  predicates and `stableRowHash` have optional leaf guards; the distinct
  `deterministicIdWithBudget(budget, ...parts)` preserves the existing rest API
  and streams the identical UTF-8 byte-length-prefixed framing. Native hash,
  regex, Date and string boundaries precharge length work and result payloads;
  late native results are discarded. No-budget IDs and preparation bytes remain
  unchanged. Hash-only canonical streaming is still an optional optimization:
  row/artifact hashes currently consume a fully reserved bounded canonical string.
- `clonePlainData(value, budget?)` returns a detached **mutable** clone of an
  admitted graph. It deliberately does not mint a shape certificate for the
  mutable result. `cloneFreezeBoundedJson` remains the distinct registered,
  immutable clone operation. `deepFreeze(value, budget?)` validates and returns
  the already transitively frozen registered graph; it does not admit or freeze
  arbitrary mutable objects. Future manifest wiring must use clone-freeze, not
  feed a mutable clone back into a registered-object entrypoint.
- Sensitive-name budget mode preserves both camel-case replacements, Unicode
  lowercase, delimiter split/filter and original predicates. Each intermediate
  string/word array/Set and each lookup is reserved/charged. Conservative UTF-8
  expansion bounds intentionally may refuse valid large strings earlier.
- `setBudgetMap`, `addBudgetSet`, `appendBudgetList` and fixed single-delimiter
  `splitBudgetString` are dependency-free helpers. Map replacement/Set duplicates
  do not reserve new entry slots; lazy Map/list value callbacks run after slot
  admission. These helpers accept application-owned native collections, do not
  register JSON shapes, and do not account arbitrary callback payload allocations.
  Callers must reserve container creation and use typed factories inside callbacks.
  Split supports comma/pipe only; parser-specific regex/trim/dedup semantics still
  require dedicated recipes and are not silently mapped onto this helper.

## Accepted transaction item loop (narrow slice, P0 still incomplete)

`normalizeTransaction` now reserves the canonical-items list and product Set
containers plus all list destinations before allocation, charges each visit and
native membership/insertion, and reserves each accepted product ref before its
literal/append. It reserves the six-part ID rest frame and line-number String
before argument evaluation, calls the existing guarded canonical encoder and
streaming deterministic-ID implementation with the same request context, then
reserves the closed maximum item spread schema before canonical-item append.
The mutable parser result and its nested lists remain mutable and uncertified.
No counters are reset/refunded and the 4,000/4,000/8,000/8,000 final caps remain.

The hash operand is the **validated immutable decoder source**, not a newly
certified projection. This is justified by the shared validator's exact-key
checks: legacy scalar values are rejected rather than normalized; checkout
scalars are copied verbatim; adjustments have exact five/six-key variants;
promotions have exact common plus type-specific keys for all four variants;
`schemaVersion` is already exactly 3. Nested strings (including accepted padded
promotion IDs/names and product IDs), numeric values and list order are retained.
Only object insertion order and mutable detachment change, which canonical JSON
ignores. Frozen HEAD oracles cover all four variants, reversed nested own-key
order, escaped Unicode, signed legacy items and accepted distinct transactions
sharing a product ref. Any future validator transformation requires revisiting
this equivalence; a caller-supplied shape assertion cannot substitute for it.

Boundary tests include the restored four genuine post-Set REDs, ref and spread
limit-minus-one/exact/plus-one sentinels, pre-String/rest refusal, immutable-source
and identical-context hash assertions, and native hash deadline/abort/error
identity. Sixteen distinct items stage naturally. A separate 512-item loop
executes every item/ref/hash with monotonically growing counters, but missing
product refs subsequently quarantine it: it is **loop fanout evidence**, not
512 accepted final rows. A 512-product input exhausts the preexisting cell
admission budget before reaching this slice; no cap was relaxed to force it in.

The subsequent final-record and cancellation layers below close transaction
scalar/status and malformed emission, normal final literal/student ref, staged
item/Target and cancellation construction seams. Other branches, relation/fixed-
point indexes and final manifest/report payload construction remain deferred.
This is not a bounded manifest API.

## Normal transaction final records and staged Targets (narrow slice)

On the actual `normalizeTransaction` path after the accepted item loop, closed
literal recipes reserve before operand/factory evaluation. They use the existing
request context and `allocate`; no new public recipe API or mutable graph
certificate is created. The accepted immutable-source item hash is unchanged.

| Reached allocation | Nodes | Slots | Structural units | Work |
| --- | ---: | ---: | ---: | ---: |
| Final 10-field canonical transaction (97 key bytes) | 11 | 10 | 193 | 11 |
| Three-field student ref plus destination | 4 | 4 | 55 | 4 |
| 12-field staged transaction plus shallow clone, three-field Target and destination | 30 | 28 | 587 | 42 |
| Maximum 19-field staged item shallow clone plus Target and destination | 24 | 23 | 487 | 24 |
| Fixed UUID String argument copy | 1 | 0 | 4 | 2 |
| Ten-field staged item base (130 key bytes) | 11 | 10 | 226 | 11 |
| Nine-field extended temporary operand plus nine destination properties (132 key bytes each) | 19 | 18 | 424 | 20 |

These are conservative closed-schema upper bounds: canonical `items` and nested
snapshot lists remain shared references. The String copy additionally reserves
36 content bytes before native String. The forEach native invocation, each
callback visit and the extended-property membership check each spend one unit.
The staged transaction's 42 work units include 12 for all four possible accepted
status comparisons and their two short string operands. Fixed recipes contain
no input-derived key enumeration; spread/assign work is precharged by their
closed field bounds. No mutable arity or caller certification is trusted.

The shared Target closure accepts an optional context from transaction (normal and cancellation), definition, and Tasks paths.
The history checkpoint below adds TaskAssignments/TaskCompletions callers. Its caller reserves the argument record AND clone/shell/slot
before evaluating arguments. It checks immediately after the shallow clone,
before append, and after append. Context omission executes the original single
spread/push expression; callers that omit context keep that original unbudgeted behavior. The staged builder reserves its base before source operands
and the extended Object.assign temporary/destination before its literal.
Native ordinary errors and both existing budget error identities still pass
through the existing normalizer boundary; late successful clones cannot append.

Tests observe the actual closed literal factories, staged getters, String,
Object.assign, clone and Target append. They distinguish preallocation refusal
from eventual downstream exhaustion, exercise limit-minus-one/exact/plus-one,
and preserve native timely/late/aborted errors, two-call cumulative ownership,
mutable/public alias topology and full JSON bytes/IDs. Existing frozen HEAD
cases cover all four promotion variants, accepted duplicate refs and 16 accepted
items. Supplemental original-Git fixtures add accepted empty TASK_REWARD,
correlated signed/zero ADMIN_ADJUSTMENT, and one accepted mixed legacy/all-four-
promotion transaction. The 512-item fixture reaches 512 staged Targets but later
quarantines for missing product refs; it is not 512 accepted output rows.

The independent final category ceilings remain **4,000 / 4,000 / 8,000 / 8,000**;
they do not replace these earlier payload reservations. Remaining C1 work still
includes scalar/status/malformed seams outside transactions, other canonical
branches, claim/binding/provenance expansion, reference /
fixed-point / cycle / adjustment indexes, and final source/diagnostic/sort/
manifest/report payloads. P0 is incomplete and P1 must not consume this as a
fully bounded manifest API.

## Cancellation transaction construction (narrow slice)

The actual transaction caller now passes the same context to its ID, instant,
integer and `cancellationOriginalId` validators. The supported-status source
array/Set is allocated through a closed recipe before the literals; status
membership and comparison work includes rejected long strings. Scalar rejection
order, native error identity, and the original cancellation-link rules remain
unchanged. The transaction-only malformed wrapper reserves one error occurrence
before calling the old error emitter; sibling branches are not newly guarded.

| Reached allocation | Nodes | Slots | Structural units | Work |
| --- | ---: | ---: | ---: | ---: |
| Five-status array, scalar occurrences and Set | 7 | 10 | 92 | 11 |
| 11-field canonical cancellation (118 key bytes), empty items array | 13 | 11 | 238 | 13 |
| Transaction and student refs, both destinations | 8 | 8 | 110 | 8 |
| Malformed occurrence and destination | 1 | 1 | 8 | 1 |
| 13-field staged cancellation, same-shape clone, Target and destination | 32 | 30 | 645 | 32 |

Canonical construction deliberately precedes cancellation rejection, including
null/invalid original IDs. The following condition reserves fixed scalar work
plus both ID string blocks. Staged construction uses a closed literal factory;
its entire future clone/Target/destination is reserved before that factory or
the shared Target caller's arguments. The clone checks before append. No mutable
result receives an immutable graph certificate, and empty items remain mutable.

Frozen Git cancellation fixtures preserve accepted original-plus-reversal rows,
invalid prefix/blank/self/missing originals, duplicates, negative/zero/positive
amount variants, nonempty items and malformed scalar/JSON cases. Reached tests
cover closed factories at limit-minus-one/exact/plus-one, same-context cumulative
calls, native success/error/abort and both existing budget-error identities,
actual staged-record clone getters, no-budget bytes/order/IDs/prototypes and
mutability. These are local cancellation guards, not certification of later
cancellation indexes, reference fixed points, claims, manifest or P1.

## Selected nested parser propagation

- `canonicalTransactionItem(value, signedLegacy?, budget?)` →
  `parseCheckoutLineSnapshot(value, budget?)` → `parsePromotionResponse(value, budget?)`
  shares one context. Budgeted object entrypoints require a same-context immutable
  source certificate before property access. Exact semantic keys, signed legacy
  rules, promotion types, adjustment order, duplicate rejection and scalar defaults
  retain their original semantics. Native trim/Date/regex and input-length string
  comparisons are precharged, including invalid long type strings.
- `parseTransactionItemsJson(text, budget?)` applies registered lexical admission
  before native parse, preserves malformed-cell null, and rethrows both budget
  error classes, including late native results. `normalize.ts` now uses it on its
  guarded branch and propagates the same context into canonical item validation.
  The omitted-context branch retains its original native JSON.parse/broad catch.
  **Item-ID serialization and canonical/target expansion remain unguarded.**
- `createBoundedParserProjection` provides closed legacy-item, checkout, adjustment
  and promotion schemas beside the private source certificates. Fixed-schema upper
  bounds are reserved before lazy source evaluation; nested lists/records are
  admitted before allocation. Promotion/adjustment variant maxima are conservative
  fixed recipes, not caller arity. It copies fixed keys directly from the admitted
  source rather than spreading uncertified intermediate parser results.
- Parser outputs retain ordinary Object prototypes, mutability and detachment,
  including nested product lists. **Mutable results deliberately receive no shape
  certificate.** Future normalizer/writer integration must construct a registered
  immutable schema projection from its admitted source; passing these mutable
  results straight to guarded canonicalJson is invalid, and freezing the old API
  is not a fix. The guarded path can copy a validated source again to avoid trusting
  intermediate mutable results; all such copies are cumulatively reserved.
- `mapBudgetList`, `trimBudgetString`, `equalBudgetValue`, `uniqueBudgetStrings`
  precharge result lists/string copies, length-dependent equality and native Set
  indexes. Empty native map/Set operations are charged too. Product indexing uses
  indexed visits rather than an unreserved native iterator. Generic callbacks still
  own their payload recipes and cannot mint certificates.
- Unreachable checkout preview/success and promotion-list APIs remain no-budget;
  their extended-export callbacks are explicit lambdas. The PromotionAdminPanel
  re-export remains unchanged and its callers use explicit single-value calls.

## Partial real normalizer entry/transaction integration

Historical checkpoint: exclusions in this section and the following row checkpoint
are superseded by the implemented slices above and the current missing-guard table.

`normalizeLegacySnapshots(input, budget?)` now checks private immutable ownership
before reading the graph, traverses admitted input with the existing structural
guard, and preflights aggregate Sheet rows <= 2,000 and aggregate Redis entries
<= 2,000 (claims, bindings, v1 tombstones and orphan digests together). Counts are
per acquisition, not per tab/list; intermediate/work usage remains request-wide
and never resets. Initial three lists/two indexes have a fixed preallocation
reservation. This is not a recipe for their subsequent entries or final output.

The actual `makeEntry` cell reader precharges native Map lookup, String coercion
and trim before returning cells. Both budget error identities survive; an
ordinary late native exception checks the deadline before it can escape. The
same context reaches the existing nested JSON decoder and item/checkout/promotion
validators, including independent nested-cell depth admission before JSON.parse.
Mutable parser outputs remain mutable and uncertified; they are **not** passed to
the guarded serializer as if they had immutable ownership.

This slice intentionally does **not** claim closed Entry/Target/canonical/source/
diagnostic recipes, category limits (4,000/4,000/8,000/8,000), full header/row/task
parser propagation, item-ID hashing, allowed-ID expansion, operational record
ownership, fixed-point/reference/cycle/claim/peer work, or final sort/serialization
guards. Passing a context cannot yet bound the whole call. Manifest construction
still has no budget API; P1 must not consume this partial implementation.

Direct normalizer byte/mutability oracles were executed from 26 byte-exact HEAD
modules, not from the modified implementation. Eleven cases supplement the six
existing manifest goldens. The archived entry/transaction tests distinguish real
pre-native refusal and five-counter boundary evidence from whole-callgraph
acceptance; they do not turn an unchanged outer join into a bounded one.

Request ceilings (inclusive except deadline exhaustion at the boundary): nodes
1,200,000; container slots 1,200,000; content 32,000,000; structural units
32,000,000; work 5,000,000; one string/buffer 8,000,000 UTF-8 bytes; depth 64;
cooperative deadline 5,000 ms. Trusted owners can tighten these limits, not raise
them. Per parse: raw text 8,000,000 bytes, decoded value string content 4,000,000,
structural units 4,000,000, nodes 300,000. Root depth is one, including scalar
roots; every child increases it by one. Duplicate keys are conservatively counted
although native parsing retains the last value.

Logical structural weights are container 16, property 4 + UTF-8 key bytes, array
slot 4, scalar occurrence 4. Scanner scratch is two 64-slot arrays reserved before
allocation: 130 nodes, 128 slots, 1,056 structural units, conservatively including
all scalar slots. Property key payload bytes are structural, matching the existing
validator accounting; decoded value strings contribute content bytes. Raw text
ownership/fetch accounting remains the caller's responsibility.

The generic `allocate` helper admits a supplied numeric recipe before invoking a
lazy factory. It **does not establish registered shapes or prove the recipe is
complete**. It is not a replacement for the required schema-specific factories.
Sort inputs are shared references; each comparison/move is charged. A caller's
length-dependent comparator must charge its own string/native work as well.

These are logical data/work limits, not V8/Temporal/Intl/crypto internal heap
instrumentation, hard RSS isolation, native interruption, or a five-second SLA.
There is no global/AsyncLocalStorage context, Node/server/environment dependency,
SQL operation, or authority grant in these primitives.

## Actual normalizer header/row caller integration — native repair, review pending

This newer checkpoint supersedes the earlier header/row missing-callsite entries
below, but is not an approved completion claim. The normalizer uses the SAME
request-owned immutable header/cell arrays for `createHeaderIndex`, `parseTaskRow`
and `parsePromotionRow`; it avoids spreads that would discard private ownership.
It does not mint any certificate for caller-owned or mutable parser graphs.

- Header arrays/count maps/known-header sets/index entries/key sorting and duplicate
  scans reserve containers/slots and charge visits before work. Header-specific
  diagnostics reserve their object/rest-list/destination slot/path before operand
  evaluation, and their digest plus redacted identity hashes receive the context.
- Real task calls reach closed schedule input construction, current/pending weekday
  and timezone parsing. Task scalar validation and chronology checks propagate
  context. Raw allowed IDs retain their separate duplicate-rejection semantics,
  original newline/comma/semicolon delimiters, trim/filter order and code-unit
  sorting, with split/output/Set/sort preallocation.
- Promotion row inputs are admitted original arrays. The mutable parser result is
  copied via a closed fixed-variant recipe without entries/fromEntries enumeration
  or registration. Common/variant property order is preserved. Shared completion
  raw evidence reads now reuse the cell coercion guard WITHOUT trimming.
- Integrated refusal sentinels cover native trim, both allowed-ID paths, current
  and pending weekday split, schedule fromEntries, promotion projection and row
  factory invocation. Original Git module executions pin no-budget and accepted
  budget bytes, IDs/order/defaults/native errors and mutable schedule results.

**Native identity blocker repaired locally; independent review still pending.**
The authorized follow-up rethrows existing BudgetExceededError and
BudgetUnavailableError objects FIRST in all five reachable row-native catches:
Date.parse, Date constructor/toISOString, task Number, promotion Number and
Number.isFinite. Only ordinary exceptions recheck the same optional context.
No-budget and timely ordinary exception identity remains unchanged. The legacy
transaction-items catch is not reachable from this normalizer task/promotion
slice and has no budget parameter; its malformed-item semantics are unchanged.
Archived initial 1,764-test RED reproduced both integrated failures. A new
96-case native-boundary matrix produced 24 genuine identity failures before the
repair (72 assertions already passed), then all 96 plus the unchanged 155 caller
tests passed in the actual repository. Evidence is in the active-profile cache
`task19-bounded-normalization/normalizer-rows/native-catch-fixes`.
Do not call this row slice SPEC/quality-approved or P0-complete.

Residuals: closed Entry/Target/canonical task/ref/error/output recipes and counters,
task instance fallback/allowed-link IDs and target expansion, transaction item IDs,
other scalar consumer propagation, all relations/fixed points/claims, final output
sort/hash/serialize, manifest context integration and P1 remain unbounded/unwired.
No cap was raised, context reset, manifest API added or live call made.

## Exact missing guard inventory / blocked integration

All of the following approved P0 work remains required:

| Seam | Missing work |
| --- | --- |
| `boundedWork.ts` | Lazy Map/list insertion, Set insertion and comma/pipe split recipes implemented. Remaining: general consumer wiring, parser-specific allowed-ID/weekday delimiters and exact semantics; no generic helper certifies arbitrary callback allocations. |
| `boundedJson.ts` | Decoder/writer/clone-freeze plus mutable uncertified clone, immutable key view and two fixed artifact projection recipes implemented. Remaining: Entry/Target/reference/diagnostic/manifest registered output recipes, decoder first-enumeration optimization if needed, optional hash sink and actual output integration. |
| `validators.ts` | Snapshot business/Settings/Redis graph guards, artifact reconstruction, hash/tuple/rest-safe ID, scalar leaves and mutable clone seams implemented and tested. Remaining: normalizer/manifest must actually pass the request context to them; standalone opt-in validator success is not bounded normalization. Public `isPlainRecord` remains an unbudgeted type predicate; budgeted business entrypoints admit the graph before calling it. |
| `manifest.ts` | Optional context ownership/threading; preallocation artifact/source metadata/diagnostics; per-manifest output counters; projection/sort-key accounting; final bounded encoding/hash/detached clone/freeze. |
| `normalize.ts` intake/output | Implemented: optional API, immutable admission, Sheet 2,000/Redis 2,000 aggregate input caps, initial containers, header/row/task/promotion caller propagation and cell coercion; SHEET pointer, mutable Entry/redacted/four-list shell, initial INVALID_HEADER occurrence and Sheet Entry destination slot preallocation; accepted transaction item loop, normal final records and staged Targets, cancellation scalar/status/canonical/ref/staged construction and transaction malformed occurrences; student/product/promotion definitions, Tasks canonical/ref/ID/staged payloads and TaskAssignments/TaskCompletions canonical/evidence/ref/staged payloads with caller-side reservations (see closed recipe checkpoints). Final-output category caps: 4,000 deduplicated canonical targets, 4,000 sources, 8,000 contributor mappings and aggregate 8,000 quarantine/conflict/error-code entries; destination slots reserved before each counted append. Remaining: other canonical/Target/ref and intermediate error expansion; derivedEntry/Redis pointer; sourceRecord/mapping/diagnostic/sourcePath payload recipes, dynamic indexes/key arrays and sorts. |
| `normalize.ts` relations | Implemented: operational assignment/completion selection, closed immutable sibling/list ownership, timestamp-key index, stable completion chronology, same-context operationalProjection call and unsupported error occurrences (checkpoint below). Remaining: adjustment/cancellation indexes, duplicate handling, every reference fixed-point pass/entry/ref/candidate, cycle paths, BANK scans, claim-peer error scans, claim/binding groups, cross-source joins and contributor multiplicity. |
| `semanticValidators.ts`, `checkoutSnapshotClient.ts`, `promotionClient.ts` | Optional nested JSON → semantic item → checkout-line → promotion now reached with the same context from normalize; nested fanout and exact-key checks implemented. Accepted item ID/hash expansion uses the immutable validated source; mutable parser and staged/canonical results remain uncertified. The actual cancellation caller now forwards context to cancellationOriginalId. The actual operational history caller now reaches subject/cycle/assignment-completion helpers with the same context. Direct sibling adjustment/correlation tuple/key calls still omit context. |
| `sheetsRows.ts` | Reachable row spread/header index/Object.fromEntries/getRowCell, trim/number conversion; task/promotion result factories and both distinct allowed-ID list semantics. Unreachable transaction parser is not claimed guarded. |
| `taskSchedule.ts`, `timeZone.ts` | Current/pending schedule and warning allocations, weekdays preflight, clone/sort/set operations, catches that rethrow budget exceptions, explicit Temporal/Intl work/result boundaries. |
| `operationalProjection.ts` | Implemented guarded operational maps, subject encoding, chronology visits and referenced semantic helpers; the actual normalizer now supplies closed owned immutable history views/lists with the identical context. BANK authority and other global joins remain separate deferred callers. |
| `sensitiveRedaction.ts`, `sheetsSnapshot.ts` | Approved name-classifier/deep-freeze/stable-row-hash seams implemented. Capture/export/redaction policies unchanged. Remaining: future parser/manifest callsites must thread context; no whole-capture/export accounting claimed. |
| Callback compatibility | canonicalJson recursion/finalGeneration contributors and validator `headers.some(isSensitiveTabName)` use explicit lambdas. Direct remaining canonicalJson maps resolve to unchanged private serializers. Native sort comparators receive only two operands. Promotion-list and checkout-preview callbacks now use explicit lambdas; extended-parser aliases/re-exports are audited. Repeat on subsequent API propagation. |
| Golden acceptance | Original six manifests and preparation ORIGINAL/CANDIDATE/PLAN bytes/IDs preserved. Added Git-blob-frozen helper/three-schema inputs and sixteen Settings/Redis/shape edge cases, including last-key-wins and scrypt positives. Budget-on validator/hash/clone and no-budget manifest/preparation regressions pass. Original Git-blob parser goldens now cover no-budget and accepted budget-on item/promotion results, including signed history and nested contributor fanout. Full budget-on normalization remains absent. |

No P1 SQL/authentication/report/DTO/diff/index/fanout work is implemented or implied.

## Final-output category emission slice (not full output construction)

`normalizationOutput.ts` is an internal typed emission helper used by the actual
normalizer, not a second business algorithm, public manifest API, registration
API or configurable limit override. Each budget-enabled normalization creates
one instance after the existing admission. Its four counters are invocation-local;
the caller's work/allocation/deadline context remains shared and cumulative.
The helper checks a category before its lazy result operand and destination
append, reserves one reference slot/four structural units and charges an emission
visit. Category failure throws the existing fixed `BudgetExceededError`; there
is no refund after a later factory/allocation failure and no partial return.

The exact mapping from the approved quarantine/conflict/error-code terminology
to existing result types is:

| Category | Counted occurrence and real emission seam |
| --- | --- |
| canonical targets, 4,000 | Each row in final `records[table]`, after the existing table/id last-value-wins deduplication. Intermediate `entry.targets` and `targetsByCollection` references are not final canonical rows; the latter destination slots are separately reserved without charging the category. |
| sourceRecords, 4,000 | Each staged or quarantined `toSourceRecord` result; admission and destination reservation precede calling that factory. Includes sheet-derived and Redis sources without changing their earlier constructors. |
| mappings, 8,000 | Every staged target contributor mapping, before the mapping literal; no deduplication or loss of contributor multiplicity. |
| diagnostics, 8,000 aggregate | One occurrence for each sourceRecord with `mappingStatus === 'QUARANTINED'`, plus each distinct `sourceRecord.errorCodes` element, plus each distinct final `blockingConflicts` element. Quarantine admission precedes its source factory, error-code admission precedes each output error array append, conflict admission precedes each final deduplicated conflict append. |

There is no `quarantines` array in this normalizer: `manifest.ts` later filters
the quarantined source records. The quarantine portion is charged once here for
that occurrence, not again for the status flag, retained canonical object, or
each repeated intermediate Entry error. Distinct per-source error codes remain
distinct occurrences from emitted conflicts; error codes of an aliased future
manifest quarantine do not create another error-code expansion here. Warnings
and warningCodes are not quarantine/conflict/error-code entries and are excluded
from this new category. The separate existing **raw warnings+conflicts 4,096**
guard and its original error remain unchanged in both modes; it can refuse
before an otherwise allowable new aggregate cap. Final conflict uniqueness and
ordering remain exactly the existing `(code, path, sourceDigest)` semantics.

These are **final-output** caps, not pre-construction guards for every temporary
object. Earlier `diag(...)` objects, raw diagnostic staging arrays, Entry flags,
canonical/temporary Target payloads outside the closed normal-transaction layer,
dedup Map/Set/key/sort scratch, remaining refs, claims,
fixed-point loops and all source/mapping payload property recipes remain separate
C1 work. Warning outputs are not newly instrumented. Do not infer full allocation
coverage, registered mutable outputs, a guarded manifest writer, or P1 readiness.

`normalize.output.budget.test.ts` exercises each internal production emitter at
limit-minus-one/exact/plus-one, combined diagnostics, simultaneous category
independence, no-reset/no-refund request accounting and lazy factory/append
sentinels. The real normalizer is instrumented with **delegating spies on those
same emitters**, not a mock business algorithm: frozen source outputs establish
exact occurrence counts, while real prefilled counter instances demonstrate each
caller fails before its next output factory/append. Those are internal capacity
sentinels, not claims that each category limit is independently reachable under
the existing 2,000 input-row/admission/allocation limits. Executed original Git
oracles also pin large no-budget output hashes above the new category limits.

## Definition canonical/Target construction checkpoint

The actual `makeEntry` branches `Students`, `Products`, `Promotions` and
`PromotionProducts` now use the identical request context through their existing
ID/integer/boolean/instant validators. `parsePromotionRow` remains the existing
budgeted row parser; its allocation recipe is not duplicated or replaced.
`promotionRecord` reuses the earlier closed mutable projection and adds bounded
work for its validated union discriminants. No new definition-local hashing was
found: definition IDs are preserved verbatim, and the existing guarded SHEET
identity hash remains before these branches.

All new recipes are closed schemas written at the caller. They reserve before
literal operands, spreads, refs, shallow Target clones and destination slots.
The shared Target cannot infer arbitrary mutable shapes: only callers which
already reserved the complete bundle supply context. It checks after its clone
and before append, with budget-error identity preserved on exception exits.
The staged factory returns the actual mutable clone operand; no certificate or
freeze is granted. Products retain lazy image/category cell reads inside the
reserved canonical factory. Students retain independent student/account clones.
No-budget malformed paths still invoke the original financial-tab native
predicate before appending, even though these four tabs are nonfinancial.

| Closed recipe | Nodes | Slots | Structural units | Work |
| --- | ---: | ---: | ---: | ---: |
| Student status array/native membership | 3 | 2 | 32 | 10 + 2 × status blocks |
| Student canonical | 5 | 4 | 74 | 5 |
| Student payload/clone/Target/destination | 14 | 12 | 214 | 14 |
| Account payload/clone/Target/destination | 12 | 10 | 192 | 12 |
| Product canonical | 9 | 8 | 136 | 9 |
| Product payload/clone/Target/destination | 24 | 22 | 368 | 24 |
| Promotion-product canonical | 6 | 5 | 116 | 6 |
| Two promotion/product refs and destinations | 8 | 8 | 110 | 8 |
| Promotion-product payload/clone/Target/destination | 18 | 16 | 328 | 18 |
| Promotion maximum-variant payload/clone/Target/destination | 34 | 32 | 1,024 | 34 |
| Nonfinancial malformed occurrence/destination | 1 | 1 | 8 | 1 |

The staged bundles conservatively include both complete scalar records and the
Target shell/destination; they do not walk or certify the mutable record. Shared
strings are references, not copies. Existing promotion projection reservation
remains 26 nodes/24 slots/768 structural units; its work is now 37. Scalar
condition work is charged separately (3/6/2/5 for student/product/promotion/link).
The narrow validator changes charge canonical-ID equality operands, final safe
integer predicates, both boolean comparisons (including rejected long inputs),
and canonical-instant finite/format/equality work. They do not change default
results, IDs or native no-budget behavior.

`definition-construction-golden.json` was executed from byte-exact original Git
modules before this checkpoint's first production edit. All four promotion
variants actually produce records, separately from malformed/quarantined cases.
The two `normalize.definitions*.budget.test.ts` suites exercise budget-off/on
bytes, cumulative same-context calls, mutable detached outputs/null-prototype
record dictionaries, factory capacity boundaries, real lazy cell and staged
clone getters, no-budget native ordering and native error identities. Additional
prehash tests confirm the already-guarded Entry seam on all four real tabs; this
is regression coverage, not a new hashing implementation. Work-boundary tests
use real cumulative contexts with delegating observers: only the selected
spend's ordinal is discovered, while each expected cost is fixed independently.

The later Tasks and history construction checkpoints below supersede definition/construction deferral here.
Operational/history global joins and sibling propagation,
derivedEntry, claims/bindings, duplicate/reference fixed points and final
source/mapping/diagnostic payload and sort/dedup scratch remain deferred. The
final category caps stay exactly 4,000/4,000/8,000/8,000. This checkpoint neither
completes P0 nor enables the manifest writer or P1.

## Tasks canonical/ref/ID/staged construction — local checkpoint

Only the actual `Tasks` subtree is added here. Existing `parseTaskRow`, schedule,
timezone and duplicate-preserving allowed-ID parser algorithms are reused, not
wrapped in a second normalizer. Accepted default/v1, NONE/DAILY/WEEKLY/MONTHLY,
month-end pending schedule with America/New_York, sorted allowed links and
prerequisite records are pinned by executed original Git bytes. Invalid current,
pending/timezone/weekdays, duplicate IDs and broken references remain distinct
quarantine fixtures. No current/pending warning/default semantics changed.

| Closed Tasks caller recipe | Nodes | Slots | Structural units | Work |
| --- | ---: | ---: | ---: | ---: |
| Canonical sixteen-field shell | 17 | 16 | 317 | 17 |
| Task payload + shallow clone + Target + destination | 40 | 38 | 720 | 40 |
| Allowed-student/prerequisite ref + destination | 4 | 4 | 55 | 5 per allowed loop visit; 4 prerequisite |
| Allowed-link four-part encoder rest array | 1 | 4 | 32 | 1 loop visit; existing encoder charges string/hash work |
| Allowed-link payload + clone + Target + destination | 12 | 10 | 196 | 12 |
| Duplicate/self-reference error + destination | 1 | 1 | 8 | 1 |
| Malformed occurrence + destination | 1 | 1 | 8 | 2, preserving original financial-tab predicate |

The canonical/Target bounds conservatively count every fixed property as a scalar
occurrence, including shared list/schedule references. The 16 canonical keys use
173 UTF-8 key bytes; the 17-field staged record adds tenantId. Each staged bundle
includes both records plus the Target shell/destination, before any literal or
spread operand. The shared Target is not trusted to account for caller literals.
Its existing same-context clone check prevents late results from appending.

Instance/prerequisite validators and allowed-link IDs now receive the same context.
The normalizer's legacy instance fallback reserves its exact UTF-8 string before
interpolation. The initial defensive sentinel substituted an empty parser-result
ID; supplemental executed Git cases establish natural reachability with a
513-code-unit instance ID, including a Unicode task ID. The final capacity
sentinel uses that accepted input and delegates to the unchanged real parser.
The original pre-edit default/current/pending/invalid oracle cases remain exact;
the two fallback cases are explicitly supplemental frozen-Git coverage.
Scalar truth/null/chronology predicates have a fixed 20-work upper bound before
the main condition; parsed/warning predicates spend 3 before reading the result.
No arbitrary mutable shape is registered, frozen or fed to guarded canonicalJson.
Canonical/task Target nested schedule/list aliases, key order, output mutability
and null-prototype record dictionaries stay unchanged.

Evidence lives in active-profile cache `task19-bounded-normalization/normalizer-task-construction/`.
Both Tasks test suites retain archived chronological RED and frozen Git parity.
Corrected pre-edit replay is separate from original RED: initial work sentinels
confused shell work with subsequent cell-lookup work, and successful Target
objects were observed again in a later collection append. Corrected tests observe
the real factory and distinct Target identity, respectively. Native chronology,
instance trim and ID/hash success/exception controls cross timely/expired/aborted/
no-budget states and preserve both original budget error objects; these are
integrated caller guarantees, not new direct-helper certification.

The history checkpoint below supersedes assignment/completion construction deferral.
Residual: operational/history global joins and siblings, derivedEntry,
claims/bindings/peers, duplicate/reference fixed points/cycles, final sorting and
source/mapping/diagnostic payload recipes, manifest optional context/writer and P1
remain deferred. Category limits remain 4,000/4,000/8,000/8,000 with no reset/refund.
This is local verification, pending independent SPEC then quality, not full P0.

## TaskAssignments / TaskCompletions construction — local checkpoint

The actual assignment and completion constructors now thread the same request
context through ID/instant/integer helpers, bounded scalar comparisons, native
chronology, lowercase, regular expressions, evidence tuple and binding hashes.
The raw author-name read remains untrimmed and is compared with its separately
trimmed cell; this is validation, not normalization of evidence. Carry/seed,
BANK authority, history/quarantine rules and later operational joins are unchanged.

| Closed history caller recipe | Nodes | Slots | Structural units | Work |
| --- | ---: | ---: | ---: | ---: |
| Assignment canonical (15 fields) | 16 | 15 | 285 | 16 |
| Assignment staged + clone + Target + destination | 38 | 36 | 658 | 38 |
| Completion canonical upper bound (27 fields) | 28 | 27 | 542 | 28 |
| Completion staged + clone + Target + destination | 62 | 60 | 1170 | 62 |
| Two base refs + destinations | 8 | 8 | 110 | 8 |
| Previous/assignment ref + destination | 4 | 4 | 55 | 4 |
| Evidence header slice | 1 | 5 | 36 | 6; mapped cell list separately reserved |
| Binding and nested evidence shells | 11 | 9 | 224 | 11 |
| Invalid-evidence canonical shell | 10 | 9 | 191 | 10 |
| Evidence spread and tuple field temporary | 7 | 6 | 159 | 7 |
| Empty evidence spread temporary | 1 | 0 | 16 | 1 |
| Error occurrence + destination | 1 | 1 | 8 | 1; malformed 2 including original financial-tab predicate |

Each canonical/staged recipe runs before literal operands, cell getters, spreads,
cloning and append. Closed schema upper bounds count shared scalar occurrences,
not arbitrary mutable shapes. Completion's evidence temporary is reserved separately
before spreading it into the pre-reserved canonical shell. Its ID remains the
validated legacy completionId; assignmentId is likewise not regenerated.

The private binding encoder writes the original sorted, fixed key layout and uses
the existing bounded canonical writer only for primitive fields, including null
and escaped/lone-surrogate strings. It reserves every scalar encoding and the
final joined string before interpolation, then calls the existing same-context
hash helper. It does not certify, freeze or pass the mutable binding/canonical
result to a registered-graph API. Tuple concatenation, tagged-hash prefix and
Unicode lowercase copies have separate preallocation and length-dependent work.
Returned record dictionaries remain null-prototype; records stay mutable, with
unchanged key ordering and shallow copy/alias behavior.

Evidence: active-profile cache
`task19-bounded-normalization/normalizer-history-construction/`. Executed original
Git modules froze accepted seed/carry/v2 records separately from invalid,
duplicate, BANK/evidence and legacy history quarantines before production edits.
Chronological RED/source hashes are retained; later stronger first-append,
prehash, evidence-shell and correctly armed chronology tests have a separate
read-only pre-edit baseline replay, not retroactively relabeled chronological RED.
Factory admission is distinguished from later cell-copy scratch exhaustion.
Native success/ordinary-error/each original budget error crosses timely, expired,
aborted and no-context controls; staged clone getters prove refusal before append.

The operational integration checkpoint below supersedes this checkpoint's
immutable-input/caller deferral. **Still deferred:** BANK authority and sibling
global history propagation; claims/bindings/peers, derivedEntry/Redis pointers,
reference fixed points/cycles, final sorts/dedup and source/mapping/diagnostic
payloads, manifest optional context/full writer and P1. No operational authority
or full P0 guarantee follows from this constructor slice. Category limits remain
4,000/4,000/8,000/8,000, without reset/refund. Accounting is cooperative logical
allocation/work, not native interruption or process-heap isolation. Independent
SPEC then quality review is required before further integration.

## Actual operational history join / chronology checkpoint

The normalizer now reaches the existing `unsupportedOperationalRecords` algorithm
with its identical cumulative request context. It does not use an alternate carry,
seed, BANK or evidence decision implementation. Native no-budget selection/sort,
helper call and assignment-first unsupported occurrence traversal remain unchanged.
The budget branch preserves completion timestamp code-unit order, Sheet row-number
ties, stable input-order ties, duplicate rows/IDs and last-ID-wins assignment lookup.

Three closed primitive-operand constructors in `boundedJson.ts` produce the public
mutable assignment, completion (with/without evidence) and invalid-evidence record
alongside a detached frozen private sibling. Only the sibling receives an owned
shape certificate. A private WeakMap pairs identities; arbitrary mutable records,
proxies, parser outputs and foreign contexts cannot obtain a view. Fixed schemas
and finite primitive operands are checked internally; there is no caller factory,
shape assertion, generic canonical-object certification or public-output freeze.
Optional evidence fields remain absent, not invented null keys. Existing output
record prototypes/key order/IDs/bytes and shallow alias contracts remain unchanged.

For `n` fixed fields with `k` total UTF-8 field-name bytes, the paired recipe
reserves **5 + 2n nodes, 2n + 8 slots, 168 + 16n + 2k structural units** before either
record, immutable shape or private association. Original constructor-shell
reservations remain conservative additional charges. Field strings are references,
not copies. The closed list recipe takes a validated count and lazy operands that
must resolve through the private association; before allocation/operands it reserves
**5 + 2n nodes, 2n + 6 slots, 16n content bytes, 160 + 12n structural units** for the
new list, numeric index-key strings/list and shape. Individual index-key string
limits use a conservative 16-byte bound; no caller input list shape is certified.

Selection lists and timestamp Map containers precede construction. Each selected
occurrence reserves its list slot; each new timestamp index entry reserves two
slots (replacements do not). String conversion gets a reserved key and native block
work before conversion. Missing invalid-evidence timestamps retain `String(undefined)`.
The existing guarded stable merge sort reserves both scratch arrays before any
comparison, uses precomputed timestamp keys and the original row-number comparator,
and charges comparisons, moves, Map operations and string-length blocks. The actual
helper owns its already-reviewed subject/cycle/index/native reservations. Unsupported
occurrences reserve one scalar node, one slot and eight structural units before the
real error append; assignment and sorted-completion groups preserve original order
without the temporary concatenation. Native checks reject late success/ordinary
errors while preserving both existing budget exception identities.

Evidence: `task19-bounded-normalization/normalizer-operational-integration/`.
Original Git execution preceded edits for carry/BANK/duplicate/chronology cases;
a supplemental original-Git trace pins the full helper input records/order separately
from final acceptance. BANK/evidence and duplicate quarantines are not relabeled
accepted. The prior ref-capacity tests now arm at the canonical factory exit,
because immutable sibling construction is newly charged after the old last-cell
sentinel; original assertions/categories are retained and the transition failures
are archived. Chronological RED, native repair RED and final archived-source replay
are distinct receipts, not cumulative test totals.

This operational slice alone is not whole-normalizer boundedness. Reference guards
are added by the subsequent section below; adjustment/cancellation/duplicate global
indexes, BANK authority, claim/binding/peer scans, derived entries/Redis pointers,
contributor/source/diagnostic payloads, final sort/dedup/serialization, manifest
integration and P1 remain deferred. Category caps
stay **4,000/4,000/8,000/8,000**, work stays **5,000,000**; no resets/refunds or native
interruption/process-heap isolation guarantee. Independent SPEC then quality review
is required before advancing.

## Actual reference fixed-point and cycle guards (local verification; review pending)

Both existing `validateReferences` calls receive the SAME request context, on each
side of operational validation. The fixed-point algorithm remains repeated passes
in original Entry/ref order; candidates retain multiplicity, the stageable filter
is not replaced by deduplication, and error-code `includes` retains first-match
semantics. The cycle algorithm still groups sorted IDs, selects unique nodes,
builds edges, walks state/positions/path, slices only the detected cycle and marks
all path states complete. It deliberately appends cycle errors directly, unlike
the fixed-point add-if-absent error path. Original tie order, quarantine propagation,
prerequisite resolution, canonical bytes/IDs and public mutability are preserved.

Reference-local recipes in `normalize.ts` own only internal mutable Entries and
indexes. They grant NO immutable graph certificate. The existing assignment /
completion tuple helper instead receives the already-private immutable siblings.

| Actual seam | Reservation / work before operation |
| --- | --- |
| business/target reference index | Map containers, per-table Maps, bucket arrays, occurrence destination slots, new Map key/value slots; each entry/target/add/get/has/set visit and key-length block |
| assignment/completion cross-checks | selection filter containers/maximum destination slots, per-callback/lookup/comparison work, primitive String copy reservations, existing same-context tuple helper |
| every fixed-point pass | pass, entry, ref, candidates lookup, every candidate filter callback/comparison and every inner error comparison; filter array/slots before native filter, scalar/error slot before append |
| cycle selection/order/index | selection list, guarded stable-sort scratch/comparison/moves; group/node/edge/state Maps and entries, Map enumeration list/entry tuples/iterator scratch before iteration |
| cycle traversal | sorted start keys/scratch; path and positions containers, each edge/state lookup, path slot and numeric state/position occurrence before insertion; exact cycle slice container/slots before native slice; direct error append storage |
| resolved prerequisite | own-property lookup and first insertion of `prerequisiteTaskInstanceId` (one slot, 30 structural units) into each canonical/Target shell before writing; second pass only replaces existing shared payload |
| native boundaries | immediate late-success/ordinary-error check; original BudgetExceededError/BudgetUnavailableError objects rethrown before checking deadline/abort |

Evidence lives at `task19-bounded-normalization/normalizer-reference-guards/`.
Pre-edit sources and executed original-Git 19-case chain/missing/cycle/duplicate/tie
oracles are separate from chronological assertion RED and later final baseline
replay. Existing frozen accepted shared-product reference and 16-item cases also
assert actual accepted transactions/items, not only quarantines. New tests exercise
both-context bytes/prototypes/mutability, reached inner work/error scans, each native
success/exception exit, cycle slice `limit-1/exact/+1`, mutable property expansion,
and same-owner debits from both actual calls.

A 40-row missing chain naturally exhausts a **stricter test-only 150,000 work**
ceiling after repeated reference passes, without counter injection. Default-cap
nested refusal tests exhaust the SAME 5,000,000 counter at a reached candidate.
A 600-task exploratory fixture hit the existing 1,200,000 slot ceiling in schedule
construction before reference validation; it is archived as an upstream refusal,
NOT claimed as natural reference-work exhaustion. No cap was raised or refunded.

This section supersedes historical reference/cycle residual mentions above, not
other residuals. BANK/claim/binding/peer work, other global indexes, final payload /
sort / serialization, manifest integration and P1 still require implementation and
independent SPEC then quality review. Logical reservations are not native execution
interruption or process heap/RSS isolation.

## BANK authority and claim-error validation checkpoint

Only the existing `quarantineUnsupportedBankAuthority` and `propagateClaimErrors`
validation calls now consume the SAME cumulative request context. The original
BANK list/map/filter/Set pipeline, contributor predicate (evaluated before BANK
membership), ordered bank membership scan, failed-source/operation/tuple Sets,
Redis peer × peer × code/ref scans, add-if-absent reference codes and repeated
`CLAIM_BINDING_CONFLICT`/authority occurrences remain intact. This is not a
claim/binding constructor or an indexed/deduplicated replacement algorithm.

| Actual validation seam | Reservation / precharged work |
| --- | --- |
| BANK selection, operation/tuple maps and truthy filters | destination container and maximum slots before each native map/filter; native invocation, callback and comparison/string blocks |
| BANK/failed-source Sets | shell and conservative input-entry slots before `new Set`; each input visit/insertion/string block precharged; individual later new entries reserve before `add` |
| membership and failed-key lookup | outer Entry and inner BANK identity visit/comparison; contributor-tab/error-code string comparisons and each native Set lookup |
| failed Sheet source projection | closed SourcePointer discriminator visit/equality/two fixed blocks; map scratch before native map; no copied digest string or new public certificate |
| Redis reference error selection | selection storage before native filter; code visit, each nested ref callback and comparison before access/scan |
| peer propagation | each outer/inner peer, identity/operation/tuple comparison, each propagated code and destination error-code comparison; scalar occurrence and destination slot before append |
| native exits | reuse immediate success/ordinary-error checks and rethrow existing budget error objects before checking deadline/abort |

Map/filter list storage uses one node, `length` slots and `16 + 4*length`
structural units. Sets reserve the same shell/maximum entry slots (including
conservative duplicate allowance); later new Set entries use one slot/four units.
Each emitted error occurrence uses one node/one slot/eight units. These are local
logical reservations, not heap/RSS measurement, native interruption, graph
admission, cap increases or proof that all normalization allocations are guarded.
Mutable Entry/canonical/Target outputs remain unfrozen and uncertified.

Evidence: active-profile cache
`task19-bounded-normalization/normalizer-bank-peer-guards/`. Executed original Git
fixtures distinguish accepted carry and a non-BANK Redis binding/claim from real
BANK authority quarantines, duplicate peer rejection and missing-reference
propagation. Tests retain frozen bytes/IDs/multiplicity and exercise reached inner
reads/default-counter refusal, filter-map/Set/error-append minus/exact/plus
boundaries, late native exits and cumulative small-sheet/80-peer work. Corrected
sentinel baseline replay is separate from chronological RED; harness source-map
stack depth and shared-canonical getter installation mistakes are documented.
A supplemental original-Git native observer also pins raw Entry error/ref order,
repeated error occurrences, canonical property order and canonical/Target alias
topology before final diagnostics can hide duplicates. Its 12 outputs match the
original pre-edit frozen final bytes; it is supplemental parity, not new defect RED.

This checkpoint supersedes BANK authority/claim-error peer validation deferrals
above ONLY. Claim/binding groups, `normalizeClaims`, `derivedEntry`, Redis source
pointers, collision/provenance expansion, adjustment/cancellation/duplicate global
indexes, final source/mapping/diagnostic/contributor payloads, sort/dedup/encoding,
manifest/full writer and P1 remain deferred. Work stays 5,000,000 and category
caps stay 4,000/4,000/8,000/8,000. Parent independent SPEC then quality review is
still required; this is neither whole bounded normalization nor P0 completion.

## Archived TDD and parity

The active-profile task cache `task19-bounded-normalization/` contains a byte-exact
583-file frozen HEAD tree and SHA-256 manifest, a pre-edit oracle generator and
its execution report, separate missing-API/behavioral RED sources and JSON
reports, and final verification/handoff artifacts. Missing-module collection
failures are explicitly distinguished from assertion RED. Added coverage that
was already green is not retroactively called a defect RED.

`normalization-budget-golden.json` is a byte-pinned pre-edit artifact generated
from the frozen real fixtures: supported schema v1/v2/v3, default quarantines,
malformed transaction items, and duplicate student. It retains full canonical
manifest bytes, source fingerprints and embedded item/claim IDs. The parity test
checks both unchanged no-budget normalization and lexical-decoder-fed no-budget
normalization against those bytes. **Neither path proves budget-on normalization.**
Do not regenerate this fixture from a later implementation. All data are existing
local synthetic fixtures; no live acquisition or credential lookup was used.

The subsequent `validator-integration/` cache separately archives genuine RED
source snapshots/reports, exact Git-blob oracle provenance, current verified
source copies/hashes and a seam-level handoff. A bundler collection failure on a
lone-surrogate JSON fixture is not behavioral RED; runtime JSON loading preserves
those original oracle bytes. No earlier evidence has been overwritten.

The `parser-integration/` cache adds immutable RED source/hash/JSON checkpoints,
original Git-blob parser oracles and current-source verification. Its initial
Array-iterator spy recursively invoked Vitest bookkeeping and exhausted the test
worker heap; that report is harness failure, not product RED. A synchronous native
wrapper restored in finally then produced the genuine iterator assertion RED.
Later edge and exact-boundary additions that passed immediately remain coverage,
not retroactive defect RED. Earlier evidence directories are unchanged.

Completion still requires full C1 callsite implementation, adversarial integration
coverage, independent SPEC then security/quality review, and parent-owned frozen
whole-suite/build verification. No staging, commit, push, or live operation is
part of this checkpoint.


## Claim construction layer (partial P0; not claim-join certification)

`normalizeClaims` now receives the same optional request context. Its Redis
source-pointer factory reserves the closed source record before invoking the
lazy canonical encoder/hash. Fixed internal variants reserve canonical records,
provenance lists and conditional spread scratch before ID rest arrays or literal
operands. All five `derivedEntry` variants reserve Entry/redacted/Target/shallow
clone/list shells before the identity hash and factory. Public canonical and
Target records remain mutable, retain legacy alias topology and receive no shape
certificate. The binding reference pair and each existing claim error occurrence
reserve before literal/append. Returned claim Entry destinations and the small
output envelope are separate intermediate allocations, not final category caps.

Evidence: active-profile cache
`task19-bounded-normalization/normalizer-claim-construction/`. Chronological shell,
source/caller, ref, output and error RED reports are distinct from later supplemental
work/native-success/exception controls and frozen-baseline replay. Original Git
claim/binding accepted, duplicate, orphan, conflict, unbound and BANK-quarantine
fixtures execute independently of changed production. Accepted non-BANK binding
and claim counts are asserted separately from quarantine output.

At the construction-only checkpoint, the following were **not guarded by that layer**: group Map entry/member/candidate scratch,
claim/sheet selection and matching, validation predicates and payload/tuple/key
encoding, collision/peer/group scans, provenance merge/map/sort, final shared-record
binding keys, collection Set entries, and outer final merge/dedup/serialization.
Existing BANK peer/reference/history guards remain in place. Fixed constructor
work is not a claim of bounded joins or naturally exhausted default work capacity.
The 5,000,000 work ceiling and final 4000/4000/8000/8000 caps are unchanged; no
reset, refund, broader manifest API, P1 or live-operation coverage is introduced.

## Claim grouping, matching, collision and provenance integration

The next claim-joins increment instruments the existing `normalizeClaims`
algorithm, not a replacement join. Same-owner Map get/has/set and group/bucket
containers, member destinations, collection Set entries, both claim×sheet and
binding×sheet filters, repeated peer/error visits and both nested collision scans
now precharge their work and derived containers. Canonical binding payloads are
encoded from admitted immutable Redis sources with the same request context.
Tuple/claim-field strings and hashes, scalar validation and comparisons are
charged before their native work; collection/native exit wrappers rethrow both
original budget error objects before checking an ordinary late exception.

`claimBindingKey` retains its literal/native canonical encoder on omitted-context
calls. The guarded path is a closed ten-field recipe in canonical code-unit key
order: reserve scalar/reference and fragment scratch before property operands,
use the bounded scalar/source encoder, reserve each escaped fragment, the join
intermediate and final string before construction. It never registers/freezes a
mutable canonical record or trusts a caller-supplied arity certificate.

Provenance uses the original member list, including repeated occurrences; no Set
is substituted. Its projected source references and stable merge-sort scratch
are reserved separately, and comparator string blocks and merge moves are
charged. Agreement still replaces only the same original canonical/Target aliases;
conflicting contributors retain their own records. Supplemental executed Git raw
oracles preserve internal error/ref ordering, source multiplicity and shared
record topology that final quarantine output can hide.

Evidence: `task19-bounded-normalization/normalizer-claim-joins/`. The initial
chronological RED covers real binding bucket reservation, the second reached
claim×sheet predicate and missing payload context. Later chronological RED covers
nonmatching inner collision candidates, provenance sort scratch/moves, binding
key admission, tuple allocation/hash context and immediate regex-success expiry.
Exact boundary and native exit supplements are labeled separately from those
original RED checkpoints; frozen pre-edit replay does not replace chronology.
Existing constructor tests move the Entry destination sentinel past newly charged
Map storage, and count the new outer/candidate visits explicitly without raising
any configured limit.

This is **not whole-normalizer/P0 certification**. Other adjustment/cancellation/
duplicate indexes, outer final claim merge/dedup/output serialization, manifest
writer/context integration and P1 remain deferred. No natural-input default
5,000,000 work exhaustion, native interruption, heap/RSS isolation or accepted
BANK authority is claimed. Parent independent SPEC then quality review remains
required; all default limits and cumulative-context ownership are unchanged.

## Global duplicate index increment (not all global validation)

The next narrow global-index slice passes the same context into `markDuplicates`
and its four existing `markBusinessDuplicate` calls. It does not combine indexes,
remove contributors, or deduplicate repeated internal error occurrences.

| Actual seam | Guarded before work/allocation |
| --- | --- |
| Target and four business indexes | Map containers; get/has/set string-block work; only new native entry slots; missing bucket containers and each member destination |
| Entry × Target / group × member loops | Each outer/inner visit, length comparison and table comparison, including skipped evidence-claim Targets |
| Target and business keys | Existing NUL framing and primitive String conversion; UTF-8 key-copy reservation before interpolation; no canonical-object shape certificate |
| Four business selections | Native filter result capacity before filter, each predicate visit and scalar string comparison/financial Set membership |
| Index group iteration | Native values iterator and ordered value-list scratch before materialization, iteration visits and duplicate length checks |
| Duplicate errors | Scalar occurrence and destination slot before append, including both student/account emissions and repeated financial/business flags |
| Native exits | Reused immediate success/ordinary-exception deadline checks, with preexisting budget error identity preserved |

No-budget duplicate ternary emission keeps its original `entry.errors.push(...)`
expression: evaluating the destination/method getter after the financial predicate
would change legacy ordinary-exception order. An executed original-Git getter
oracle exposed that intermediate regression; its separate chronological RED and
repair are archived. Mutable Entry/canonical/Target aliases remain mutable and
uncertified; no closed graph recipe was needed for these primitive string keys.

Evidence: `task19-bounded-normalization/normalizer-global-index-guards/`.
The original Git loader executed 25 cases before production edits: accepted
adjustment linking, accepted cancellation pairs, duplicate student/task/settings/
promotion/financial occurrences, malformed cancellation and duplicate cancellation
conflicts. Both final bytes/IDs and raw Entry errors/refs/Target aliases are frozen;
raw duplicate-student errors retain two occurrences per source. Real Map container,
bucket/entry, key-copy, value/filter scratch and error-append exact−1/exact/exact+1
sentinels are separate from reached work-exhaustion and native exit controls.

This slice uses default contexts with reached-capacity sentinels. It makes no
natural-input 5M exhaustion claim and uses no lowered test work cap to stand in
for such proof. Defaults remain 5M and 4000/4000/8000/8000, with no reset/refund.
**Still deferred:** `correlateAdjustments` indexes/key-helper context/union/Target
linking; `validateTransactionCancellations` indexes, pair checks and malformed
propagation; required-Settings global validation; outer final merge/dedup/sort/
serialization; manifest optional-context writer and P1. Executing parity for
adjustments/cancellations does not certify their still-uninstrumented algorithms.
Parent independent SPEC followed by quality remains required.


## Adjustment correlation increment (parent SPEC → quality pending)

This checkpoint supersedes only the `correlateAdjustments` deferral above. Its
actual caller now passes the same cumulative request context, without a reset,
refund or cap change. The original two-index algorithm and ordered native Set
union remain in place; no semantic deduplication or contributor rewrite is used.

| Actual seam | Reservation / work boundary |
| --- | --- |
| Transaction and adjustment indexes | Both Map containers, missing buckets, new Map entries and member destinations; every outer visit and string lookup/comparison |
| Key helper inputs | Closed fixed-field detached scalar/item copies, list/index-key storage and private immutable shapes; reserve before lazy canonical operands; never freeze or certify the public mutable canonical record |
| `adjustmentTransactionKey` / `adjustmentKey` | Same-owner registered input and same context; existing canonical tuple encoder; integer native completion checks before subsequent validation, preserving original budget error identity |
| Key union | Both native key iterators, union array, Set and entry/scratch allowance before native materialization; string-block Set work before its constructor |
| Ambiguous / malformed paths | Original includes semantics via the existing guarded error scan; each inner visit/comparison; implicated concatenation and pair temporary; each distinct-at-this-point error occurrence and append slot |
| Resolved link | New `transactionId` canonical property before its operand/coercion; separate Ref shell/destination and adjustments Target/seven-field record/destination before literals and getters |
| Native exits | Immediate successful/ordinary-error completion checks; pre-existing BudgetExceededError / BudgetUnavailableError objects rethrown unchanged; literal result checked before later append |

The source-view recipe only copies a closed set of scalar fields and item fields
into new objects, validates them, freezes those new objects and installs private
same-owner certificates. It does not enumerate arbitrary canonical keys or grant
a certificate to a caller factory's returned object. Public records, output
mutability, alias topology, key order and duplicate error occurrences retain their
legacy contract. The omitted-context resolved branch keeps the original
String/property/destination/method/literal evaluation expressions.

Evidence: active-profile cache
`task19-bounded-normalization/normalizer-adjustment-correlation/`. The original
Git loader executed 35 cases, including accepted add/subtract/set links, missing
links, malformed items, duplicate/ambiguous pairs and Unicode key operands. Final
bytes/IDs, raw Entry error/ref order and Target aliases are frozen; separate
no-budget key-getter traces are also produced by those original Git modules.

The first implementation attempt was discarded in full because its original
RED did not cover all requested allocation boundaries. Cumulative pre-existing
sources were restored byte-for-byte; complete corrected tests then executed
before the final implementation. `red-final-preproduction.json` is that restart's
chronological RED, not a later read-only replay. Earlier exploratory runs, the
native observer's excessive stack-inspection overhead and the TypeScript-only
harness correction are retained separately. Final baseline replay is a separate
receipt and must not replace the chronological record.

Reached work and allocation probes exercise exact−1/exact/exact+1 boundaries,
including first Map, bucket/entry, key-input shells, union/key iterators,
implicated/pair scratch, error scan/append, canonical property, Ref and Target
operand admission. Native success/ordinary/both original budget errors are crossed
with timely/expired/aborted/omitted-context execution. These are reached-capacity
sentinels, **not natural input exhaustion of the default 5,000,000 work cap**.
No test cap is lowered. Defaults remain 5M work and 4000/4000/8000/8000 categories.

**Still deferred:** cancellation cross-row indexes/pair validation/propagation;
required-Settings global checks; outer final merge/dedup/sort/serialization;
manifest optional-context writer and P1. Adjustment row construction before
correlation is not newly certified by this checkpoint. It does not claim every
counter at every callsite, native interruption, heap/RSS bounds, wall-clock SLA
or completion of the whole P0. Parent independent SPEC then quality is required.

Verification receipt for this increment: the final serial selection reuses all
45 files / 4789 assertions from the prior successful JSON report and adds one
284-test file: **46 files / 5073 passed**. Full typecheck, scoped lint and Git
whitespace checks pass. A separate getter-repair RED (284/281/3) verifies that
error destination storage is reserved before its getter and that a late canonical
getter cannot mutate transactionId before deadline/abort refusal. The existing
manifest source-inventory test still sees the real native transaction-index
declaration; its test was not changed. Post-GREEN direct helper controls (14,
not added to the selection total) verify source non-certification/detachment,
foreign-context rejection and freeze/shape-install error identity. These
supplements are not retroactively called chronological RED.


## Cancellation cross-row validation increment (parent SPEC → quality pending)

This checkpoint supersedes only the cancellation cross-row deferrals above.
The actual `validateTransactionCancellations(entries, budget)` call uses the
existing request owner through all nested filters, both ID indexes and buckets,
lookups, ordered scalar comparisons, candidate loops and error destinations.
It does not alter the cancellation constructor or adjustment correlation rules.

| Actual seam | Pre-admitted logical storage / work |
| --- | --- |
| Transaction, reversal, cancelled filters | One container, input-length slot upper bound, 16 + 4n structural units before native filter; each predicate visit and string comparison |
| Both indexes and buckets | 16-unit Map/list containers, bucket member slots, two-slot new Map destinations; string-block lookup/set work before native operations |
| String / Date.parse / Number | Closed primitive operands, string copy admission before String, date text-block work before Date.parse, numeric native work and immediate completion checks |
| Ordered pair | Thirteen scalar occurrences / 52 structural units before predicate operands: two dates, six Number results, two negations, two differences, final predicate; no array pair or map projection is constructed |
| Malformed propagation | Every candidate and native forEach visit, includes worst-case scan of fixed short diagnostic codes, one error occurrence and destination before the errors getter/method/append |
| Native completion | Same-context checks after success and ordinary exceptions; original BudgetExceededError / BudgetUnavailableError identity takes priority over expiry/abort |

No public mutable canonical record is frozen or certified. No detached view is
needed: this validator uses only closed transaction scalar fields. The original
contextless algorithm is retained byte-for-byte in the unbounded sibling so that
native method/getter evaluation order, short circuiting and errors remain stable.
The bounded branch retains the two-index algorithm, input order, native includes,
forEach and filter semantics, final bytes/IDs, raw error/ref multiplicity and
canonical/Target alias topology. Error-list scan work uses the normalizer-owned
fixed diagnostic vocabulary (all codes shorter than 256 UTF-16 units), not an
arbitrary mutable JSON graph certificate.

Evidence lives at active-profile cache
`task19-bounded-normalization/normalizer-cancellation-validation/`.
Byte-exact cumulative sources and manifests were archived before changes.
Executed original Git cases cover accepted cancellation/reversal plus duplicate,
missing, malformed, mismatched financial/student and earlier/equal date cases;
raw entries, errors/refs, aliases and no-context getter traces are frozen.
`red-preproduction.json` is chronological pre-implementation RED; earlier harness
corrections and later read-only baseline replay are separate receipts.

The boundaries are reached exact−1/exact/exact+1 capacity sentinels, not a natural
input proof of default 5M exhaustion, a heap bound, native interruption or an SLA.
No limits, counters, resets or refunds change: 5M work and 4000/4000/8000/8000 output
categories remain in place. Required Settings/timezone checks, upstream Adjustment
construction, outer final merge/dedup/sort/encoding, manifest writer/context and P1
remain deferred. This is not whole-P0 completion; independent parent SPEC then
quality are still required.

## Required Settings / timezone validation increment (SPEC and quality APPROVED)

The actual `validateRequiredSettings` caller now passes the existing cumulative
request context. Settings selection and per-key native filters reserve their
containers/input-length slots before execution, charge each predicate visit and
string comparison, and check native success/ordinary exception completion. The
native error propagation loop retains every matched occurrence and its order;
its error node/destination is reserved before the Entry errors getter. Missing
paths, Diagnostic keys/shell, variadic list/destination and SHA-256 use the same
owner and are reserved before their operands. Schema-version native String has
its own scalar-copy reservation rather than a changed comparison/coercion rule.

Timezone validation retains the original trim, case-sensitive UTC special case,
regex and `Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions()` semantics.
No supported-values cache, alternate alias lookup or canonicalization replaces
Intl. Trim-copy, regex shell/scan, options/key/formatter handle and default-date
resolved result's seven fixed keys/scalar occurrences plus temporary slots are
pre-admitted. The result key vocabulary is locale/calendar/numberingSystem/
timeZone/year/month/day (49 ASCII key bytes). Host ICU internals and host metadata
string representations remain opaque trusted native runtime data, not a JS heap
or native-interruption bound. No public mutable Entry/canonical/result is frozen
or given an immutable shape certificate.

The no-context Settings sibling preserves the original function body. Native
ordinary errors retain the original false/catch behavior; existing budget-error
objects in the guarded branch are rethrown before expiry/abort checks. Executed
original Git fixtures cover valid/missing/duplicate/version values, accepted
aliases and rejected zones, exact final bytes and raw error/ref/Target aliases.
Getter-order and throwing-getter oracles are archived separately from later
supplemental canonical-value getter cases.

Evidence: active-profile cache
`task19-bounded-normalization/normalizer-required-settings/`. Chronological
preproduction RED, a separate resolved-key scratch repair RED, subsequent GREEN,
and final pre-edit replay have separate reports and source hashes. Supplemental
post-GREEN work ±1 controls and getter-value parity are not retroactive TDD.

The earlier four cancellation sentinel failures are resolved by the authorized
sentinel-only relocation to the final missing-timezone diagnostic append exit.
Original assertions/allowances remain unchanged. Independent combined quality
executed the real repository selection: 48 files / 5692 passed / 0 failed / 0
skipped, full typecheck, scoped lint and diff checks. SPEC and quality approved
this Settings/timezone plus sentinel slice; this is not whole-P0 approval.
See `normalizer-required-settings/sentinel-fix/quality-review/QUALITY.md` for
frozen-baseline replay, reservation-removal mutants and source/index receipts.
The original BLOCKED reports remain historical evidence, not current acceptance.

No default limits change (5M work; 4000/4000/8000/8000 categories), reset, refund,
cap relaxation or public alias replacement is introduced. Upstream Adjustment
construction, final merge/dedup/sort/encoding, manifest writer/context, and P1
remain deferred. Independent parent SPEC then quality remain required.

## Upstream Adjustment construction (independent SPEC + QUALITY passed)

Independent `normalizer-adjustment-construction/spec-review/SPEC.md` and
`quality-review/QUALITY.md` passed this scope: each reran the installed 49-file /
5970-assertion selection, full process-only 4GB-heap typecheck, scoped lint and
diff check. Original handoff/RED evidence remains historical and unchanged.
This approval is not full P0 or Settings initial-constructor approval.

This increment supersedes only the upstream Adjustment construction deferral.
The actual `makeEntry` branch passes the existing context to initial ID, instant,
integer and operator-digest validators. Before native mode `includes`, its literal
and fixed/string-block work are reserved, including rejected long modes. The
seven-field public mutable canonical shell is reserved before its hash operand;
the UTF-8 input frame and existing SHA-256 digest reservation are independent.
The initial student Ref and malformed error occurrences reserve their literals
and destinations before append. Native success and ordinary failure completion
check the same context; preexisting budget error identity takes precedence.

The shared source/Entry shell, identity digest and Entry destination were already
guarded. This slice adds Adjustment-only append/empty Target-visit work and
completion checks without double-reserving that destination. No initial Target,
record clone or generated adjustment ID exists in this branch: the approved
`correlateAdjustments` layer owns later linking/Target construction and is unchanged.
No arbitrary mutable canonical/source object is frozen or certified. The exact
no-budget branch retains getter order, errors, key order and mutable aliases.

Evidence: `task19-bounded-normalization/normalizer-adjustment-construction/`.
Pre-edit sources and executed original Git accepted add/subtract/set/Unicode,
malformed/missing/key/error/raw-alias and cell-getter fixtures precede production
edits. Chronological reached work/allocation/hash/append ±1 RED is separate from
an initial ref-observer overcount correction and later frozen-baseline replay.
Follow-up native sentinels exposed two further intermediate completion defects:
financial-Set success could append a malformed occurrence after expiry, and
SHA-256 update success could run digest after expiry. Separate pre-repair RED
reports cover both. The Adjustment malformed branch now checks that predicate;
the necessary existing `sha256` helper checks createHash/update/digest individually
and prioritizes existing budget errors on ordinary-error exits. Its byte framing,
no-budget native chain and established accounting are otherwise unchanged.
These are reached cumulative-context sentinels, not natural default-5M exhaustion,
all-counter/callsite certification, heap/RSS/native interruption or whole P0.
Final merge/dedup/sort/encoding, manifest writer/context and P1 remain deferred.
At that checkpoint the sibling Settings row constructor still had unguarded
canonical/Target, omitted-setting digest/warning and malformed expansions;
approval of `validateRequiredSettings` above did not approve initial construction.
The narrow next increment below supersedes only that construction deferral.
5M and 4000/4000/8000/8000 limits, no-reset/no-refund semantics are unchanged.

## Settings initial row construction (SPEC / QUALITY approved; raw parity approved)

The initial `makeEntry` Settings branch now uses the existing request context for
cell reads, missing-key predicates and error occurrence, operational Set lookup,
canonical construction, staged Target argument/shallow clone/Target/destination,
omitted-value SHA-256 input frame and warning occurrence. Shared cell conversion,
Source/Entry shell, identity hash and Entry destination reservations are reused,
not charged twice. No generated ID is involved: operational Targets share the key.

Closed recipes: operational canonical 3 nodes / 2 slots / 40 structural bytes;
omitted canonical 3 / 2 / 46; staged setting plus clone/Target/destination
12 / 10 / 176 (closed upper bound: 56 + 56 + 49 + 4, with 11 structural
bytes and one node of margin); malformed and warning occurrence/destination
1 / 1 / 8 each. The variable UTF-8 hash frame is separate from the shared SHA
helper's existing digest reservation. Work precedes constructors, predicates,
encoding operands, native append, empty Target visit and per-Target iteration.
Collection membership/expansion/add is checked individually: even a successful
`has` on an already-present collection cannot proceed to add after expiry/abort.
No arbitrary mutable source/canonical/Target graph is registered or frozen.

The original no-budget constructor expression is retained verbatim apart from
indentation. Executed frozen Git cases cover operational/omitted/empty values,
missing keys, duplicate keys, Unicode/lone surrogate, trimmed and native-coerced
values, final bytes/IDs/key order, raw errors/refs/Target aliases and cell getter/
throw traces. Public outputs remain mutable with null-prototype final records.
Required Settings/timezone validation and all later normalizer functions remain
byte-exact; existing cancellation and claim-observer tests are untouched.

Evidence: `task19-bounded-normalization/normalizer-settings-construction/`.
Chronological pre-production RED (280 assertions, 57 failures), initial harness
corrections, a separate collection-membership completion RED (296, 2 failures),
and later archived-source replay (296, 69 failures) are kept distinct. Initial
collection work controls used 4 rather than the actual 6 units (visit + callback
+ native Set pair); that test arithmetic correction is archived, not a cap change.
Final installed Vitest selection: **50 files / 6266 passed**, including the exact
prior 5970 assertion-name multiset; full process-only 4GB-heap typecheck, scoped
lint and diff check pass. These are reached same-context capacity sentinels,
not natural-input default-5M exhaustion or every-counter/every-callsite proof.

Final merge/dedup/sort/encoding, manifest writer/context and P1 remain deferred.
Default 5M / 4000 / 4000 / 8000 / 8000 and no-reset/no-refund are unchanged.
Independent `spec-review/SPEC.md` and `quality-review/QUALITY.md` both approve
this narrow Settings constructor. The later maintained raw-observer repair is
independently approved in `raw-parity-followup/review/REVIEW.md`: **50 files /
6266 passed**, including initial Entry append and later Map membership, actual
hooked getter noninterference and raw duplicate-error mutation sensitivity.
These approvals do not claim full P0, heap/RSS bounds, native interruption or a
wall-clock SLA.

## Caller-owned claim receiving merge (GREEN; parent SPEC → QUALITY pending)

Only the handoff immediately after `normalizeClaims(input, entries, budget)` is
newly guarded. The claim constructor/body, business grouping and later passes
are unchanged. No-budget Entry spread, diagnostic rest call and collection
forEach/add retain their original expressions and evaluation order.

One cumulative context pays **new outer receiving slots**, not upstream payloads
or already-paid claim-local slots. Entry reception uses an indexed loop: one
initial work unit plus two per reference, one slot/four structural bytes before
the source element, checked element access, then checked native push. It creates
no input-sized Entry argument buffer. Existing Entry/Target/canonical objects,
strings and alias topology are retained, without registration, freeze or clone.

The raw claim-conflict list is naturally empty in the current claim constructor.
Its real empty rest list (one node / 16 structural bytes) and native push still
run after one work unit. A separately labeled synthetic future nonempty test
covers receiving/rest/argument slots and iterator scratch (3 nodes, 3n slots,
48+12n structural bytes), 1+n work, and unchanged whole-batch legacy 4096 rejection
ordering. This is not evidence of naturally emitted claim diagnostics.

Collection union pays for empty native traversal, every callback, both
name-length-sensitive membership/add operations, and only genuinely new outer
Set slots. Existing checked private `claimCollection` / `referenceNative` are
reused unchanged. Both true and false has exits check before successor work or
add; successful and ordinary-error native exits check the same context, while
both existing budget-error objects take precedence and retain identity.

Evidence: `task19-bounded-normalization/normalizer-claim-merge/`. An initial
attempt and harness errors are retained separately; the implementation was
fully discarded back to the archived cumulative normalizer before the final
chronological TDD restart. `restart-red-final.json` records **212 tests / 48
failures** before the retained production edit, then `green-focused.json`
records **212 passed**. Later coverage strengthening is not retroactive RED:
final maintained suite has **216 passed**, and the read-only cumulative-baseline
replay has **166 passed / 50 failed**. Independent reservation/post-push/post-has
removal and dropped/duplicated contributor mutations fail as intended.

Executed original Git modules freeze 20 natural fixtures, final bytes/IDs/order,
initial Entry and Map observations, receiving multiplicity, raw errors/refs,
canonical shared identity, actual Redis provenance and collection insertion
order. Agreeing Sheet+Redis and escaped-Unicode variants share a claim canonical
record but remain BANK-authority quarantined; they are not described as accepted
final claims. Orphan/v1 tombstones and the valid Redis binding/claim case have
explicit accepted-row checks. Hooked/unhooked original getter traces agree.

Final exact prior 50 files plus the new suite: **51 files / 6482 passed / zero
failed or skipped**, `green-current-complete.json`; full process-only 4GB tsc,
scoped ESLint and diff check pass. A first full run's existing BANK peer test
5000ms timeout is retained; unchanged-limit reruns pass and no sibling test was
edited. All other production, the raw index, previous evidence and 583 original
Git blobs/frozen archives are preserved. Independent parent SPEC then QUALITY
are still required for this new receiving seam.

Final source/mapping/diagnostic construction, dedup/sort/key scratch, writer and
manifest context/encoding, finer sibling collection/native guards and P1 remain
deferred. This section supersedes only the claim receiving-merge deferral, not
the remainder of the final-stage inventory. Defaults 5M / 4000 / 4000 / 8000 /
8000, no-reset/no-refund, mutable public outputs and contextless production
manifest callers remain unchanged. Selected regression GREEN is not full P0,
whole-project test acceptance, natural default-cap exhaustion or a native
interruption/heap/RSS guarantee.
