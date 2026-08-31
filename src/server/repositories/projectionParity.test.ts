import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createProjectionParityFixture,
  PUBLIC_PROJECTION_FORBIDDEN_FIELDS,
  type ProjectionParityFixture,
} from './testing/projectionParityFixture';

vi.mock('server-only', () => ({}));

let fixture: ProjectionParityFixture;

beforeAll(async () => {
  fixture = await createProjectionParityFixture();
});

afterAll(async () => {
  await fixture?.close();
});

describe('canonical Sheets/PostgreSQL public projection parity Gate A', () => {
  it.each([
    ['getStudentById(active)', 'student.active'],
    ['getStudentById(inactive)', 'student.inactive'],
    ['getStudentById(missing)', 'student.missing'],
    ['getActiveProducts', 'products.active'],
    ['getProductById(active)', 'product.active'],
    ['getProductById(inactive)', 'product.inactive'],
    ['getProductById(missing)', 'product.missing'],
    ['getActivePromotions', 'promotions.active'],
    ['getPromotionById(active)', 'promotion.active'],
    ['getPromotionById(inactive)', 'promotion.inactive'],
    ['getPromotionById(missing)', 'promotion.missing'],
    ['getActiveTasks', 'tasks.active'],
    ['getTaskById(active)', 'task.active'],
    ['getTaskById(inactive)', 'task.inactive'],
    ['getTaskById(missing)', 'task.missing'],
    ['getTransactionById(ordered promoted items + cancellation)', 'transaction.cancelled'],
    ['getTransactionById(missing)', 'transaction.missing'],
  ] as const)('%s has exact outward DTO parity', async (_label, contractId) => {
    const contract = fixture.contracts.get(contractId);
    expect(contract, `missing parity contract ${contractId}`).toBeDefined();

    await expect(contract!.postgresql()).resolves.toEqual(await contract!.sheets());
  });

  it('never serializes internal Padlet configuration or completion evidence', async () => {
    const publicJson = JSON.stringify(await fixture.readAllPublicGateAProjections());

    for (const forbiddenField of PUBLIC_PROJECTION_FORBIDDEN_FIELDS) {
      expect(publicJson).not.toContain(`\"${forbiddenField}\"`);
    }
  });
});
