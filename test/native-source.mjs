import { readFileSync } from 'node:fs';

// Native storage/bridge code lives in the shared runtime; window lifecycle
// lives in the Activity. Existing source-contract tests cover both.
export const nativeSource = () => ['FolioRuntime', 'MainActivity'].map(name =>
  readFileSync(new URL(`../android/src/org/fanfolio/${name}.java`, import.meta.url), 'utf8')).join('\n');
