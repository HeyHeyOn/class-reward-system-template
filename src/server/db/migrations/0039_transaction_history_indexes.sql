-- Nonunique: the read model must continue detecting duplicate reversal links.
CREATE INDEX transactions_cancellation_lookup_idx
  ON transactions (tenant_id, reverses_transaction_id)
  WHERE kind = 'CANCELLATION';

-- Admin keyset pages use the same tie order as the existing transaction reader.
CREATE INDEX transactions_tenant_history_idx
  ON transactions (tenant_id, occurred_at DESC, event_sequence ASC);
