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
