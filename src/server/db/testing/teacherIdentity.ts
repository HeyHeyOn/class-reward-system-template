import { readFile } from 'node:fs/promises';
import { currentLegalRevision } from '@/lib/legalDocuments';
import type { GoogleSession } from '@/server/googleOAuth';
import { createTeacherSessionStore, type TeacherSessionBinding, type TeacherSessionQueryable } from '@/server/teacherSession';

/** Synthetic DB fixture only: issue the same durable identity and agreement used after OAuth. */
export async function issueTeacherTestSession(db: TeacherSessionQueryable, identity: Pick<GoogleSession, 'subject' | 'email'>): Promise<GoogleSession & TeacherSessionBinding> {
  const store = createTeacherSessionStore(db);
  const version = currentLegalRevision().version;
  const { accountGeneration, sessionId } = await store.begin(identity.subject, version);
  await store.mutate({ subject: identity.subject, accountGeneration, sessionId }, 'AGREE', { version });
  return { ...identity, accountGeneration, sessionId, agreement: version, issuedAt: Date.now() };
}

/** Apply the reviewed production ACL to the owned disposable cluster's fixed runtime role. */
export async function grantProductionTestRuntime(owner: TeacherSessionQueryable) {
  const grants = await readFile('src/server/db/provisioning/runtimeGrants.sql','utf8');
  await owner.query(grants.replaceAll('crs_app_runtime','app_runtime'),[]);
}
