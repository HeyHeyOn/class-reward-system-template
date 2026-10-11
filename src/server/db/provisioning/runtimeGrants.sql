-- Apply after migrations 0001–0053 as the migration owner, in the same
-- transaction as creation of crs_app_runtime LOGIN NOSUPERUSER NOBYPASSRLS
-- NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION. Never grant role membership.
-- Passwords and provider URLs belong to the provisioning runner, not this file.
-- This ACL covers ordinary central classroom use. Migration, bootstrap and
-- generator services require separate roles and are intentionally excluded.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crs_app_runtime;
GRANT SELECT ON tenants, tenant_memberships, tenant_auth_secrets,
  tenant_sessions, legacy_task_origins, legacy_transaction_origins,
  migration_sources, padlet_claim_digest_tombstones TO crs_app_runtime;
-- Derived projections are maintained only by owner-owned event triggers.
REVOKE ALL ON task_ledger_checkpoints, task_history_revisions,
  task_history_prefixes, task_history_entries FROM crs_app_runtime;
GRANT SELECT ON task_ledger_checkpoints, task_history_revisions,
  task_history_prefixes, task_history_entries TO crs_app_runtime;
GRANT INSERT ON tenant_sessions TO crs_app_runtime;
GRANT SELECT, INSERT, UPDATE ON students, accounts, products, promotions,
  tasks, tenant_settings, operations TO crs_app_runtime;
GRANT SELECT, INSERT, DELETE ON promotion_products, task_allowed_students
  TO crs_app_runtime;
GRANT SELECT, INSERT ON transactions, transaction_items, adjustments,
  inventory_ledger, task_assignments, task_completions, audit_events,
  padlet_evidence_claims TO crs_app_runtime;
-- The claim trigger is SECURITY INVOKER and reserves this shared namespace.
GRANT INSERT ON padlet_claim_digest_registry TO crs_app_runtime;
-- PostgreSQL SELECT ... FOR UPDATE/SHARE requires UPDATE on at least one
-- column. Ledger row triggers reject mutations; no DELETE/TRUNCATE is granted.
GRANT UPDATE (id) ON tenants, tenant_memberships TO crs_app_runtime;
GRANT UPDATE (transaction_id) ON transactions, transaction_items, inventory_ledger TO crs_app_runtime;
GRANT UPDATE (tenant_id) ON task_assignments, task_completions,
  task_allowed_students, promotion_products TO crs_app_runtime;
GRANT USAGE ON SEQUENCE task_assignments_event_sequence_seq,
  transactions_event_sequence_seq, inventory_ledger_event_sequence_seq,
  task_completions_event_sequence_seq TO crs_app_runtime;
-- Class tree (0044): settings and trees change in place, drops are append-only.
GRANT SELECT, INSERT, UPDATE ON growth_settings, class_trees TO crs_app_runtime;
GRANT SELECT, INSERT ON tree_drops TO crs_app_runtime;
GRANT USAGE ON SEQUENCE tree_drops_event_sequence_seq TO crs_app_runtime;
-- Student storage (0045–0046): an item changes only when it is used, taken back, or a purchase is
-- cancelled; a digital product mark (and its type) is set by the teacher.
GRANT SELECT, INSERT, UPDATE, DELETE ON coupon_products TO crs_app_runtime;
GRANT SELECT, INSERT ON student_items TO crs_app_runtime;
GRANT UPDATE (used_at, revoked_at, used_transaction_id) ON student_items TO crs_app_runtime;
-- Pets (0048–0049): settings, pets (accessories too) and rooms (companions too) change in place; growth
-- and cares are append-only; owned decor changes only when its purchase is cancelled.
GRANT SELECT, INSERT, UPDATE ON pet_settings, pets, pet_rooms TO crs_app_runtime;
GRANT SELECT, INSERT ON pet_growth, pet_cares, pet_decor TO crs_app_runtime;
GRANT UPDATE (revoked_at) ON pet_decor TO crs_app_runtime;
GRANT USAGE ON SEQUENCE pet_growth_event_sequence_seq TO crs_app_runtime;
GRANT EXECUTE ON FUNCTION
  public.platform_find_tenant_by_slug(text),
  public.platform_find_membership_by_tenant_and_google_subject(uuid,text),
  public.platform_list_memberships_by_google_subject(text),
  public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text),
  public.platform_get_new_class_setup(text,text),
  public.platform_start_new_class_authenticated(uuid,text,text,uuid,uuid,text),
  public.platform_consume_tenant_login_attempt(uuid),
  public.platform_revoke_tenant_session(text,integer),
  public.platform_list_class_dashboard(text),
  public.platform_manage_class_authenticated(uuid,text,text,text,text,bigint,uuid,uuid,text),
  public.platform_latest_user_agreement(text),
  public.platform_has_user_agreement(text,text),
  public.platform_get_user_profile(text),
  public.platform_begin_teacher_session(text,text),
  public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
  public.platform_mutate_teacher_account(text,text,uuid,uuid,jsonb),
  public.platform_end_teacher_session(text,uuid,uuid) TO crs_app_runtime;
-- Mutations require a durable, unexpired account session; the old helpers remain private to
-- the generation-checked definer wrapper. Erasure helpers/context are never runtime-accessible.
REVOKE ALL ON FUNCTION public.platform_create_draft_class(uuid,text,text,text),
  public.platform_start_new_class(uuid,text,text),
  public.platform_manage_class(uuid,text,text,text,text,bigint),
  public.platform_lock_teacher_session(text,uuid,uuid,text),
  public.platform_record_user_agreement(text,text),
  public.platform_save_user_profile(text,text,jsonb), public.platform_withdraw_user(text),
  public.platform_purge_withdrawal(uuid), public.platform_withdrawal_erasure_allowed(uuid)
  FROM crs_app_runtime;
REVOKE ALL ON public.teacher_identity_generations, public.teacher_auth_sessions,
  public.withdrawal_erasure_context, public.account_withdrawals, public.user_agreements,
  public.user_profiles FROM crs_app_runtime;
