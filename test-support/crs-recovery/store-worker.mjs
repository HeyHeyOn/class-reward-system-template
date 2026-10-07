// Private subprocess IPC, not a public CLI/API. stdin carries the synthetic key
// and fixture bytes; stdout is captured by the supervisor, NEVER sent to a log.
import { retainSyntheticPgDump, retrieveSyntheticPgDump } from '../../src/server/exports/syntheticPgRecovery.ts';
let key;
try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 8 * 1024 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof input.key !== 'string') throw new Error();
  key = Buffer.from(input.key, 'base64');
  if (key.toString('base64') !== input.key || key.length !== 32) throw new Error();
  let output;
  if (input.mode === 'retain') {
    if (typeof input.dump !== 'string') throw new Error();
    const dump = Buffer.from(input.dump, 'base64');
    if (dump.toString('base64') !== input.dump) throw new Error();
    output = await retainSyntheticPgDump({ ...input, key, dump });
  } else if (input.mode === 'retrieve') {
    const recovered = await retrieveSyntheticPgDump({ ...input, key });
    output = { ...recovered, dump: recovered.dump.toString('base64') };
  } else throw new Error();
  process.stdout.write(JSON.stringify({ ...output, pid: process.pid }));
} catch {
  process.stderr.write('Synthetic recovery refused.\n');
  process.exitCode = 1;
} finally { key?.fill(0); }
