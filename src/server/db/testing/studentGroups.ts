import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PgliteDatabaseHarness } from './pglite';

/** Adds 0057 (student QR codes) and 0060 (모둠) to the reader harness, which stops before the class trash (0038). */
export async function installStudentGroups(harness: PgliteDatabaseHarness): Promise<void> {
  const migration = (name: string) => readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8');
  if (!(await harness.database.query("SELECT to_regclass('public.students') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='students' AND column_name='qr_code') AS has").then((r) => (r.rows[0] as { has: boolean }).has))) {
    await harness.database.exec(await migration('0057_student_qr_codes.sql'));
  }
  await harness.database.exec(`DO $$ BEGIN
    IF to_regprocedure('public.guard_deleted_class_write()') IS NULL THEN
      CREATE FUNCTION public.guard_deleted_class_write() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN COALESCE(NEW, OLD); END $f$;
    END IF;
  END $$;`);
  await harness.database.exec(await migration('0060_student_groups.sql'));
  await harness.database.exec('GRANT SELECT, INSERT, UPDATE, DELETE ON student_groups TO app_runtime');
}
