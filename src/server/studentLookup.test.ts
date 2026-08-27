import { describe, expect, it, vi } from 'vitest';
import { confirmStudentLookup } from './studentLookup';

const headers = ['studentId', 'name', 'balance', 'status'];
const active = ['S1', '김학생', '100', 'ACTIVE'];
const inactive = ['S1', '김학생', '100', 'INACTIVE'];
const malformed = ['S1', '김학생', '', 'ACTIVE'];

function reader(initial: string[][], fresh: string[][]) {
  return {
    getRows: vi.fn(async () => initial.map((row) => [...row])),
    getRowsFresh: vi.fn(async () => fresh.map((row) => [...row])),
  };
}

describe('confirmStudentLookup', () => {
  it('returns an active student without an unnecessary confirmation read', async () => {
    const source = reader([headers, active], [headers, active]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toMatchObject({
      status: 'FOUND', student: { studentId: 'S1', name: '김학생', balance: 100, status: 'ACTIVE' },
    });
    expect(source.getRowsFresh).not.toHaveBeenCalled();
  });

  it('recovers when the first snapshot misses the student but the fresh snapshot finds it', async () => {
    const source = reader([headers], [headers, active]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toMatchObject({ status: 'FOUND' });
    expect(source.getRowsFresh).toHaveBeenCalledWith('Students');
  });

  it('recovers when the first target row is malformed but the fresh snapshot is valid', async () => {
    const source = reader([headers, malformed], [headers, active]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toMatchObject({ status: 'FOUND' });
  });

  it('returns unavailable instead of not-found when the target row remains malformed', async () => {
    const source = reader([headers, malformed], [headers, malformed]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toEqual({ status: 'UNAVAILABLE' });
  });

  it('returns not-found only after two consistent missing snapshots', async () => {
    const source = reader([headers], [headers]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it('returns inactive only after two consistent inactive snapshots', async () => {
    const source = reader([headers, inactive], [headers, inactive]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toEqual({ status: 'INACTIVE' });
  });

  it('returns unavailable for inconsistent missing and inactive snapshots', async () => {
    const source = reader([headers], [headers, inactive]);

    await expect(confirmStudentLookup(source, 'S1')).resolves.toEqual({ status: 'UNAVAILABLE' });
  });
});
