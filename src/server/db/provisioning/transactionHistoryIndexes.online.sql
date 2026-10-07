-- Online counterpart of migration 0039 for an existing production database.
-- Run with an authorized owner connection, outside any transaction wrapper.
-- These catalog-only checks disclose no transaction/student rows.
-- Existing names must be valid/ready and have the exact definitions below;
-- IF NOT EXISTS alone does not repair an invalid or differently defined index.

SELECT i.relname AS index_name, x.indisvalid, x.indisready, pg_get_indexdef(i.oid) AS definition
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'transactions'
  AND i.relname IN ('transactions_cancellation_lookup_idx', 'transactions_tenant_history_idx');

CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_cancellation_lookup_idx
  ON public.transactions (tenant_id, reverses_transaction_id)
  WHERE kind = 'CANCELLATION';

CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_tenant_history_idx
  ON public.transactions (tenant_id, occurred_at DESC, event_sequence ASC);

-- Both rows must report indisvalid=true and indisready=true. Record the exact
-- definitions before marking migration 0039 applied in the deployment record.
SELECT i.relname AS index_name, x.indisvalid, x.indisready, pg_get_indexdef(i.oid) AS definition
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'transactions'
  AND i.relname IN ('transactions_cancellation_lookup_idx', 'transactions_tenant_history_idx');
