CREATE TRIGGER inventory_ledger_immutable
BEFORE UPDATE OR DELETE ON inventory_ledger
FOR EACH ROW EXECUTE FUNCTION reject_immutable_ledger_change();
