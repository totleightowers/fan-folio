import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Pinned native HTTP dependencies; shared by the APK build and JVM tests.
// Downloaded files are verified even when already cached.
const artifacts = [
  ['com/squareup/okhttp3/okhttp/4.12.0/okhttp-4.12.0.jar', 'b1050081b14bb7a3a7e55a4d3ef01b5dcfabc453b4573a4fc019767191d5f4e0'],
  ['com/squareup/okio/okio-jvm/3.6.0/okio-jvm-3.6.0.jar', '67543f0736fc422ae927ed0e504b98bc5e269fda0d3500579337cb713da28412'],
  ['org/jetbrains/kotlin/kotlin-stdlib/1.9.10/kotlin-stdlib-1.9.10.jar', '55e989c512b80907799f854309f3bc7782c5b3d13932442d0379d5c472711504'],
  ['org/jetbrains/kotlin/kotlin-stdlib-jdk8/1.9.10/kotlin-stdlib-jdk8-1.9.10.jar', 'a4c74d94d64ce1abe53760fe0389dd941f6fc558d0dab35e47c085a11ec80f28'],
  ['org/jetbrains/kotlin/kotlin-stdlib-jdk7/1.9.10/kotlin-stdlib-jdk7-1.9.10.jar', 'ac6361bf9ad1ed382c2103d9712c47cdec166232b4903ed596e8876b0681c9b7'],
  ['org/jetbrains/annotations/13.0/annotations-13.0.jar', 'ace2a10dc8e2d5fd34925ecac03e4988b2c0f851650c94b8cef49ba1bd111478'],
  ['org/brotli/dec/0.1.2/dec-0.1.2.jar', '615c0c3efef990d77831104475fba6a1f7971388691d4bad1471ad84101f6d52'],
];
const directory = fileURLToPath(new URL('../android/.deps/', import.meta.url));
await mkdir(directory, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const [artifact, checksum] of artifacts) {
  const file = join(directory, artifact.split('/').at(-1));
  let existing;
  try { existing = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!existing || hash(existing) !== checksum) {
    const response = await fetch(`https://repo.maven.apache.org/maven2/${artifact}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Dependency download failed: ${artifact}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== checksum) throw new Error(`Dependency checksum mismatch: ${artifact}`);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, file);
  }
  files.push(file);
}
console.log(files.join(process.argv.includes('--classpath') ? ':' : '\n'));
