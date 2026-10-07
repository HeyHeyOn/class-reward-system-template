-- Synthetic application-schema data only. Direct seed, NOT importer/cutover.
-- psql variables are validated UUIDs / positive safe integer in the runner.
BEGIN;
INSERT INTO tenants(id,slug,display_name) VALUES (:'tenant','synthetic-recovery','SYNTHETIC RECOVERY');
INSERT INTO users(id,google_subject,canonical_email) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','synthetic-subject','fixture@example.invalid');
INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES (:'tenant','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','OWNER');
INSERT INTO tenant_auth_secrets(tenant_id,kind,secret_hash,hash_algorithm) VALUES (:'tenant','RECOVERY_CODE','SYNTHETIC-NONCREDENTIAL','synthetic');
INSERT INTO tenant_settings(tenant_id,settings) VALUES (:'tenant','{"currencyUnit":"synthetic"}');
INSERT INTO tenant_setting_extras(tenant_id,setting_key,setting_value) VALUES (:'tenant','synthetic','true');
INSERT INTO students(tenant_id,student_id,name) VALUES (:'tenant','s','SYNTHETIC STUDENT');
INSERT INTO accounts(tenant_id,student_id,balance) VALUES (:'tenant','s',23);
INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES (:'tenant','p','SYNTHETIC PRODUCT',2,5);
INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at)
VALUES (:'tenant','promo','SYNTHETIC PROMOTION','fixture','FIXED_DISCOUNT',1,'2026-01-01T00:00:00Z','2027-01-01T00:00:00Z');
INSERT INTO promotion_products(tenant_id,promotion_product_id,promotion_id,product_id) VALUES (:'tenant','link','promo','p');
INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule)
VALUES (:'tenant','ti','t','SYNTHETIC TASK','fixture',3,'{"ruleVersion":1,"effectiveFrom":"2026-01-01T00:00:00Z","timeZone":"Asia/Seoul","recurrence":{"type":"DAILY"},"resetCompletionOnCycle":true,"resetAssignmentOnCycle":true}');
INSERT INTO task_allowed_students(tenant_id,task_instance_id,student_id) VALUES (:'tenant','ti','s');
INSERT INTO task_assignments(tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source)
VALUES (:'tenant','assignment','t','ti','cycle','2026-01-01T00:00:00Z',1,'Asia/Seoul','s','ASSIGNED','LEGACY_SEED');
INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash)
VALUES (:'tenant','op','TASK_REWARD',repeat('a',64));
INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,reverses_transaction_id)
VALUES (:'tenant','adjust','2026-01-01T00:00:00Z','s','SYNTHETIC STUDENT','ADMIN_ADJUSTMENT',20,20,0,20,'SYNTHETIC',NULL),
(:'tenant','buy','2026-01-02T00:00:00Z','s','SYNTHETIC STUDENT','CHECKOUT',2,-2,20,18,'SYNTHETIC',NULL),
(:'tenant','cancel','2026-01-03T00:00:00Z','s','SYNTHETIC STUDENT','CANCELLATION',-2,2,18,20,'SYNTHETIC','buy');
INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,operation_id,operation_hash)
VALUES (:'tenant','reward','2026-01-04T00:00:00Z','s','SYNTHETIC STUDENT','TASK_REWARD',3,3,20,23,'SYNTHETIC','op',repeat('a',64));
INSERT INTO adjustments(tenant_id,adjustment_id,transaction_id,mode,requested_amount,operator_snapshot)
VALUES (:'tenant','adjustment','adjust','add',20,'SYNTHETIC');
INSERT INTO transaction_items(tenant_id,transaction_id,product_id_snapshot,current_product_id,product_name_snapshot,quantity,unit_price_snapshot,subtotal_snapshot)
VALUES (:'tenant','buy','p','p','SYNTHETIC PRODUCT',1,2,2),(:'tenant','cancel','p','p','SYNTHETIC PRODUCT',1,2,-2);
INSERT INTO inventory_ledger(tenant_id,product_id,transaction_id,quantity_delta,stock_before,stock_after,reason,occurred_at)
VALUES (:'tenant','p',NULL,5,0,5,'LEGACY_IMPORT','2026-01-01T00:00:00Z'),
(:'tenant','p','buy',-1,5,4,'CHECKOUT','2026-01-02T00:00:00Z'),(:'tenant','p','cancel',1,4,5,'CANCELLATION','2026-01-03T00:00:00Z');
INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,task_name_snapshot,student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status,cycle_id,cycle_start_at,rule_version,timezone,source,assignment_id,transaction_id,operation_id,operation_hash)
VALUES (:'tenant','completion','2026-01-04T00:00:00Z','ti','t','SYNTHETIC TASK','s','SYNTHETIC STUDENT',3,20,23,'COMPLETED','cycle','2026-01-01T00:00:00Z',1,'Asia/Seoul','BANK','assignment','reward','op',repeat('a',64));
INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
VALUES ('PADLET','synthetic-board','synthetic-post',encode(digest(convert_to('synthetic-board','UTF8') || decode('00','hex') || convert_to('synthetic-post','UTF8'),'sha256'),'hex'),:'tenant','op','2026-01-04T00:00:00Z','SYNTHETIC');
INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES (repeat('b',64),repeat('c',64),'SYNTHETIC');
INSERT INTO migration_jobs(tenant_id,job_id) VALUES (:'tenant',:'job');
INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
VALUES (:'tenant',:'job','synthetic-source','GOOGLE_SHEETS','SYNTHETIC-NOT-AN-EXTERNAL-ID',repeat('d',64));
INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
VALUES (:'tenant',:'job','synthetic-source','synthetic-snapshot','PREFLIGHT',repeat('d',64),'{}',1);
INSERT INTO audit_events(tenant_id,event_id,job_id,event_type) VALUES (:'tenant','candidate',:'job','SYNTHETIC'),(:'tenant','plan',:'job','SYNTHETIC');
INSERT INTO migration_final_generations(tenant_id,job_id,generation_id,original_source_id,original_snapshot_id,candidate_event_id,plan_event_id,candidate_manifest_digest,candidate_sheet_digest,expected_state_version)
VALUES (:'tenant',:'job','synthetic:' || :'generation','synthetic-source','synthetic-snapshot','candidate','plan',repeat('d',64),repeat('d',64),1);
-- Deliberately remains LOCAL_CANDIDATE, never a final authority receipt.
COMMIT;
