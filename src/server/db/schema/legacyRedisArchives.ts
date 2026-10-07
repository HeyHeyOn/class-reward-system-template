import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { RedisClaimSnapshot } from '@/server/migration/redisClaimSnapshot';
import { migrationSources } from './migrations';
export const legacyRedisSnapshotArchives=pgTable('legacy_redis_snapshot_archives',{
  tenantId:uuid('tenant_id').notNull(),jobId:text('job_id').notNull(),sourceId:text('source_id').notNull(),
  sourceDigest:text('source_digest').notNull(),snapshot:jsonb('snapshot').$type<RedisClaimSnapshot>().notNull(),
  importedAt:timestamp('imported_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
  primaryKey({columns:[t.tenantId,t.jobId,t.sourceId]}),
  foreignKey({columns:[t.tenantId,t.jobId,t.sourceId],foreignColumns:[migrationSources.tenantId,migrationSources.jobId,migrationSources.sourceId]}),
  check('legacy_redis_snapshot_archives_source_digest_check',sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_redis_snapshot_archives_snapshot_check',sql`jsonb_typeof(${t.snapshot})='object'`),
]);
export const legacyClaimPublications=pgTable('legacy_claim_publications',{
  tenantId:uuid('tenant_id').notNull(),jobId:text('job_id').notNull(),sourceId:text('source_id').notNull(),
  sourceDigest:text('source_digest').notNull(),tombstoneCount:integer('tombstone_count').notNull(),
  publishedAt:timestamp('published_at',{withTimezone:true}).defaultNow().notNull(),
},t=>[
  primaryKey({columns:[t.tenantId,t.jobId,t.sourceId]}),
  foreignKey({columns:[t.tenantId,t.jobId,t.sourceId],foreignColumns:[legacyRedisSnapshotArchives.tenantId,legacyRedisSnapshotArchives.jobId,legacyRedisSnapshotArchives.sourceId]}),
  check('legacy_claim_publications_source_digest_check',sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
  check('legacy_claim_publications_tombstone_count_check',sql`${t.tombstoneCount}>=0`),
]);
