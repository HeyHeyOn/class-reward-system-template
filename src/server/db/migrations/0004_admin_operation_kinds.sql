ALTER TABLE operations
  DROP CONSTRAINT operations_kind_check;

ALTER TABLE operations
  ADD CONSTRAINT operations_kind_check CHECK (operation_kind IN (
    'CHECKOUT',
    'CANCELLATION',
    'ADMIN_ADJUSTMENT',
    'TASK_REWARD',
    'STUDENT_ADMIN',
    'PRODUCT_ADMIN',
    'PROMOTION_ADMIN',
    'TASK_ADMIN',
    'SETTINGS_ADMIN',
    'MIGRATION_IMPORT',
    'CUTOVER',
    'EXPORT'
  ));
