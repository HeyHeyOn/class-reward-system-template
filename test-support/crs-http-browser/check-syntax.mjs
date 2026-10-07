// Syntax-only: no Vitest/config discovery, typecheck, application import or emit.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const files = ['boundary.ts', 'cdp.ts', 'fixture.ts', 'acceptance.ts', 'vitest.isolated.config.mts'].map(name =>
  path.join(root, 'test-support/crs-http-browser', name));
files.push(path.join(root, 'src/app/c/[slug]/admin/migrations/history/download.acceptance.test.tsx'));
let errors = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
  });
  const diagnostics = output.diagnostics ?? [];
  errors += diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length;
  for (const diagnostic of diagnostics) console.log(`${path.relative(root, file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
}
console.log(JSON.stringify({ tool: `typescript.transpileModule ${ts.version}`, files: files.length,
  syntaxErrors: errors, semanticTypecheck: 'NOT_RUN', applicationExecution: 'NOT_RUN',
  http: 'NOT_RUN', browser: 'NOT_RUN', pg: 'NOT_RUN' }));
process.exitCode = errors ? 1 : 0;
