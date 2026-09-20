import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * Two gates for every PowerShell script in `scripts/`.
 *
 * 1. It must parse under **Windows PowerShell 5.1**, which is what the release
 *    path actually runs (`pwsh` on this machine is 5.1). A script that only
 *    parses under PowerShell 7 is not a script this project can ship.
 * 2. A script whose text is not pure ASCII must start with a UTF-8 BOM. 5.1
 *    decodes a BOM-less file with the ANSI code page, so a Chinese operator
 *    message turns into mojibake and can fail parsing outright. The BOM is the
 *    only thing that makes the encoding unambiguous; several editors and diff
 *    tools drop it silently, which is why this gate exists.
 */

const scriptsDir = join(import.meta.dirname, '..', 'scripts');
const scripts = readdirSync(scriptsDir).filter(name => name.endsWith('.ps1')).sort();
const releaseWorkflow = join(import.meta.dirname, '..', '.github', 'workflows', 'release-desktop.yml');

/** Parse one script with the Windows PowerShell parser; returns its diagnostics. */
function parseDiagnostics(path) {
  const probe = '$errs=$null;$t=$null;'
    + '[System.Management.Automation.Language.Parser]::ParseFile($env:PS_TARGET,[ref]$t,[ref]$errs)|Out-Null;'
    + 'if($errs){$errs|ForEach-Object{$_.Message};exit 1};exit 0';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', probe], {
    encoding: 'utf8',
    env: { ...process.env, PS_TARGET: path },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

test('every release script parses under Windows PowerShell 5.1', () => {
  assert.ok(scripts.length > 0, 'no PowerShell scripts were found to check');
  for (const name of scripts) {
    const { status, output } = parseDiagnostics(join(scriptsDir, name));
    assert.equal(status, 0, `${name} does not parse under Windows PowerShell: ${output}`);
  }
});

test('the release workflow hands the publish script its switches literally', () => {
  // PowerShell's array splatting passes its elements as *positional* arguments, so
  // a parameter name inside `@arguments` never binds: the script would read
  // '-Directory' as its -Directory value and see neither switch, then refuse the
  // call on its own mutual-exclusion check. That is how every 0.3.0 release
  // attempt died in CI with nothing but "exit code 1". Hashtable splatting is the
  // form that carries parameter names, and the step must pass its switch as a
  // literal on the command line.
  const calls = readFileSync(releaseWorkflow, 'utf8')
    .split('\n')
    .filter(line => line.includes('publish-desktop-release.ps1'));
  assert.ok(calls.length >= 2, `expected the workflow to call the publish script twice, found ${calls.length}`);
  for (const line of calls) {
    assert.doesNotMatch(line, /@arguments/, `array splatting cannot bind a switch: ${line.trim()}`);
    assert.match(line, /@parameters\b/, `the step must splat a hashtable of parameter names: ${line.trim()}`);
    assert.match(line, / -(Upload|Publish)\b/, `the step must pass its switch literally: ${line.trim()}`);
  }
});

test('a script with non-ASCII text carries a UTF-8 BOM', () => {
  for (const name of scripts) {
    const bytes = readFileSync(join(scriptsDir, name));
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const nonAscii = bytes.some(byte => byte >= 0x80 && !hasBom);
    if (!nonAscii) continue;
    assert.ok(
      hasBom,
      `${name} contains non-ASCII text but has no UTF-8 BOM; Windows PowerShell 5.1 would decode it as ANSI. `
      + 'Restore it with: [System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false))), (New-Object System.Text.UTF8Encoding($true)))',
    );
  }
});
