CREATE FUNCTION reject_immutable_ledger_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable ledger row in % cannot be changed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER transactions_immutable
BEFORE UPDATE OR DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();

CREATE TRIGGER adjustments_immutable
BEFORE UPDATE OR DELETE ON adjustments
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();
