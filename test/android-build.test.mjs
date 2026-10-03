import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('a compiler failure cannot publish a partial APK even when some classes were emitted', () => {
  const source=readFileSync(new URL('../android/build.sh',import.meta.url),'utf8');
  const compile=source.slice(source.indexOf('javac -nowarn'),source.indexOf('echo "5/7'));
  const dir=mkdtempSync(join(tmpdir(),'folio-build-test-'));
  try {
    mkdirSync(join(dir,'build/classes'),{recursive:true});
    const result=spawnSync('bash',['-c',`set -euo pipefail
SDK_JAR=unused
javac() { touch build/classes/Partial.class; return 1; }
${compile}
touch published
`],{cwd:dir,encoding:'utf8'});
    assert.notEqual(result.status,0,'the compiler failure must fail the build');
    assert.equal(existsSync(join(dir,'published')),false,'do not continue to packaging');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
