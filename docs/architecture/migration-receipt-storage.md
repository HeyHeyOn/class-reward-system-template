# Migration receipt storage is not action authority

Migration 0013 and `authorityReceiptStorage.ts` provide internal archival consistency only. There is no production trusted approval/freezing-consent intake, public endpoint, capability mint, or forward-cutover consumer. SQL persistence, a matching membership row, and digest shape do not authenticate an actor or prove consent. Do not wire this factory to request data or use its result to advance a job.

## Bindings and atomicity

The storage factory is bound to a canonical lowercase tenant UUID and a trusted tenant transaction runner. Input has an exact scalar field set; identity, source, action, expected job status/version, preflight fingerprint, issuer/content/replay digests and issuance/expiry are detached before awaits. START_FREEZING_APPROVAL and FREEZING_CONSENT bind READY preparatory intent, without nonexistent final capture hashes. ACTIVATE_APPROVAL binds FINAL_IMPORT and additionally requires exact final Sheet, Redis and report digests. Freezing consent's issuer digest is reserved for separately verified isolated OAuth-client provenance; storage cannot verify that provenance.

Fresh append locks tenant then job then source and actor/membership, requires IMPORTING tenant lifecycle, exact current job/source bindings and OWNER/ADMIN membership, and checks issuance/expiry using the database clock after locks. Maximum receipt lifetime is ten minutes. Receipt and globally unique replay row are inserted in one transaction, with exact joined readback before commit. Every retry of the same artifact is refused, even with identical bindings. Constraints, immutable UPDATE/DELETE triggers and forced tenant RLS apply to both tables; no runtime grants or replay TTL cleanup are installed. The trusted database/schema owner remains outside this consistency threat model.

The DDL alone does not enforce fresh intake or mandatory pairing of arbitrary direct SQL inserts. The internal transaction does. Direct SQL receipt insertion cannot create action authority, even if it satisfies every constraint. Existing application entrypoints do not import the storage factory.

## Uncertain commit recovery

A lost commit response is not success or permission to replay. Open a new tenant transaction and recover using the exact receipt UUID and every original binding including the replay digest. A joined exact match returns only `storage: NON_AUTHORITY`; it is archival readback even after expiry, membership removal or job change. No matching receipt means no proven commit: retry the future trusted upstream ceremony only as that ceremony's external semantics allow. Recovery never updates history, extends expiry, releases a fence, deletes a grant or permits an action.

## Unmet production gates

A separately reviewed composition must authenticate the session/canonical tenant, explicit displayed action intent, isolated OAuth purpose/client, actor/resource/job/version, and derive stable globally domain-separated replay digests from verified random challenges, never caller idempotency IDs or secret hashes. Existing Google ownership capabilities do not prove consent; process-local OAuth cookie replay tracking is not durable authority. Existing bridge readers lack central canonical trust resolution and fleet-wide maintained exclusion.

Forward cutover additionally requires immutable final/delta generations, independent final reconciliation, maintained complete-writer fencing (including old deployments, drain, schedulers and human Sheet writes), and preserved BANK/quarantine blockers. Zero numeric deltas do not waive unsupported history. These operational approvals are separate from permission to implement local code.

## Local verification scope

Real PGlite tests apply every production migration and use a NOSUPERUSER NOBYPASSRLS runtime role. They exercise immutable relations, SQL shapes, fresh append/refusals, cross-tenant global replay, write suppression, transaction rollback, lost commit response recovery, archival expiry/state drift, and schema columns/named constraints. This is not a multi-process PostgreSQL concurrency/load test or a production role-provisioning test. Parent SPEC review, then security/quality review and full-suite/build acceptance remain required.
