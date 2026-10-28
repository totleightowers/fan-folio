import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { brotliCompressSync } from 'node:zlib';

test('native archive HTTP: headers, compression, cookies, redirects, forms and single-attempt failures', t => {
  if (spawnSync('javac', ['-version']).error) { t.skip('JDK unavailable'); return; }
  const path = relative => fileURLToPath(new URL(relative, import.meta.url));
  const deps = spawnSync(process.execPath, [path('../tools/android-dependencies.mjs'), '--classpath'], { encoding: 'utf8' });
  assert.equal(deps.status, 0, deps.stderr);
  const classpath = deps.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), 'folio-http-'));
  try {
    const built = spawnSync('javac', ['-cp', classpath, '-d', dir,
      path('../android/src/org/fanfolio/ArchiveHttp.java'), path('./java/ArchiveHttpCheck.java')], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const brotli = brotliCompressSync(Buffer.from('<html>saved chapter</html>')).toString('base64');
    const run = spawnSync('java', ['-cp', `${dir}:${classpath}`, 'org.fanfolio.ArchiveHttpCheck', brotli], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
