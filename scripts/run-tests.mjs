#!/usr/bin/env node
/**
 * Run the suite with a private TEMP directory, then delete it.
 *
 * Every test that needs an environment builds it under `os.tmpdir()`, and no test
 * removes those trees: one run leaves dozens of sandboxes behind (`dpx-storage-*`,
 * `dpx-cli-*`, `dpx-registry-*`, whole environments built by the doctor and
 * release tests) and this machine had accumulated several gigabytes of them.
 * Pointing the child's `TEMP`/`TMP`/`TMPDIR` at one directory per run keeps that
 * leak inside a tree that is removed here, without touching a single test.
 *
 * The child inherits stdio, so the reporter's output and the exit code pass
 * through unchanged. A failing run keeps its sandbox on purpose: that environment
 * is the evidence for whatever went wrong.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dpx-test-run-'));
const env = { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox };

// `--test` takes the same file pattern the npm script passes through; the child
// expands it, exactly as `node --test test/*.test.js` did before.
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env });

if (result.error) {
  console.error(`[dpx] could not start the test runner: ${result.error.message}`);
}
if (result.status === 0) {
  // Retries because an antivirus scanner or an indexer can hold a handle for a
  // moment, and `force` so a leftover read-only file cannot fail a green run.
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} else {
  console.error(`\n[dpx] tests did not pass; this run's temp sandboxes are kept at ${sandbox}`);
}
process.exit(result.status ?? 1);
