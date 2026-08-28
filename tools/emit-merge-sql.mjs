/**
 * Write the merge steps out for the shell to run.
 *
 * The statements live in app/core/store/merge.js because that is where they can
 * be tested against real databases. The shell cannot import JavaScript, and a
 * second copy in Java would drift from the tested one — so the build emits the
 * tested statements as an asset and the shell reads them back.
 */
import { MERGE_STEPS, REINDEX_STEPS } from '../app/core/store/merge.js';

const SEPARATOR = '\n;;\n';
process.stdout.write([...MERGE_STEPS, ...REINDEX_STEPS].join(SEPARATOR));
