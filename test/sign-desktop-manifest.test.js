import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/**
 * The offline signer and the installer's verifier must agree on one contract:
 * a signature over `dpx-desktop-release/v1\n<version>\n<assetName>\n<sha256>\n`.
 * A round trip through both sides is the only thing that proves it.
 */

const tool = join(import.meta.dirname, '..', 'scripts', 'sign-desktop-manifest.mjs');
const node = process.execPath;

function runTool(args) {
  return spawnSync(node, [tool, ...args], { encoding: 'utf8' });
}

function manifestBody(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'DPXDesktopRelease',
    channel: 'desktop',
    version: '0.3.0',
    tag: 'desktop-v0.3.0',
    platform: 'win32-x64',
    assetName: 'DSH-DeepSeek-Harness-Desktop-0.3.0-x64.exe',
    sha256: 'a'.repeat(64),
    size: 123,
    ...overrides,
  };
}

test('the offline signer produces a signature the manifest verifier accepts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpx-sign-'));
  const generated = runTool(['--generate-key', '--out-dir', dir]);
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = (await readFile(join(dir, 'desktop-release-pub.txt'), 'utf8')).trim();
  assert.match(generated.stdout, /fingerprint \(sha256 of SPKI DER\): [0-9a-f]{64}/);

  const manifestPath = join(dir, 'desktop-latest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestBody(), null, 2)}\n`, 'utf8');

  const signed = runTool(['--manifest', manifestPath, '--key', join(dir, 'desktop-release-key.pem')]);
  assert.equal(signed.status, 0, signed.stderr);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sig.algorithm, 'ed25519');
  assert.equal(Buffer.from(manifest.sig.signature, 'base64').length, 64);
  // The default key id is a fingerprint prefix, so two keys never collide silently.
  assert.match(manifest.sig.keyId, /^[0-9a-f]{16}$/);

  const verified = runTool(['--verify', '--manifest', manifestPath, '--public-key', publicKey]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(
    (({ signed: isSigned, verified: isValid, algorithm }) => ({ isSigned, isValid, algorithm }))(JSON.parse(verified.stdout)),
    { isSigned: true, isValid: true, algorithm: 'ed25519' },
  );

  // Every fact the signature covers must invalidate it when changed.
  for (const [field, value] of [['sha256', 'b'.repeat(64)], ['version', '0.3.1'], ['assetName', 'other.exe']]) {
    const tampered = { ...manifest, [field]: value };
    const path = join(dir, `tampered-${field}.json`);
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    const result = runTool(['--verify', '--manifest', path, '--public-key', publicKey]);
    assert.notEqual(result.status, 0, `${field} should not verify after a change`);
    assert.match(result.stderr, /签名验证失败/);
  }
});

test('a seed-based key signs and verifies, and an unrelated key is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dpx-sign-'));
  const generated = runTool(['--generate-key', '--out-dir', dir]);
  assert.equal(generated.status, 0, generated.stderr);
  const publicKey = (await readFile(join(dir, 'desktop-release-pub.txt'), 'utf8')).trim();

  // A raw 32-byte seed is the offline-ceremony alternative to a PEM file.
  const seed = 'c'.repeat(64);
  const manifestPath = join(dir, 'desktop-latest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifestBody(), null, 2)}\n`, 'utf8');
  const signed = runTool(['--manifest', manifestPath, '--key', `hex:${seed}`, '--key-id', 'ceremony-1']);
  assert.equal(signed.status, 0, signed.stderr);
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).sig.keyId, 'ceremony-1');

  const other = runTool(['--generate-key', '--out-dir', join(dir, 'other')]);
  assert.equal(other.status, 0, other.stderr);
  const unrelated = (await readFile(join(dir, 'other', 'desktop-release-pub.txt'), 'utf8')).trim();

  const rejected = runTool(['--verify', '--manifest', manifestPath, '--public-key', unrelated]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /签名验证失败/);

  // The key that did sign it still works, which keeps the rejection meaningful.
  const accepted = runTool(['--verify', '--manifest', manifestPath, '--public-key', publicKey]);
  assert.notEqual(accepted.status, 0, 'the generated key must not verify the seed-signed manifest');
});
