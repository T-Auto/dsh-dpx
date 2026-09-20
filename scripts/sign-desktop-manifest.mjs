#!/usr/bin/env node
/**
 * Offline signing for a desktop release manifest.
 *
 * The private key never reaches CI: this script is the offline half of the
 * contract implemented by `src/desktop-release.js`. Only the public key ships
 * (in `assets/windows/`, published with its fingerprint, injected into a
 * machine through `DPX_DESKTOP_PUBLIC_KEY`).
 *
 * What is signed: the *digest message*, not the manifest bytes —
 *   `dpx-desktop-release/v1\n<version>\n<assetName>\n<sha256>\n`
 * The downloader already rejects an asset whose bytes do not hash to `sha256`,
 * so a valid signature transitively authenticates the installed launcher. This
 * also avoids depending on how PowerShell and JavaScript format the manifest.
 *
 * Usage:
 *   # one-time, on an offline machine
 *   node scripts/sign-desktop-manifest.mjs --generate-key --out-dir <dir>
 *
 *   # after `build-desktop-launcher.ps1` produced dist/desktop-latest.json
 *   node scripts/sign-desktop-manifest.mjs --manifest dist/desktop-latest.json --key <dir>/desktop-release-key.pem
 *
 *   # verify before publishing (public key only; safe in CI)
 *   node scripts/sign-desktop-manifest.mjs --verify --manifest dist/desktop-latest.json --public-key <base64 SPKI DER>
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { desktopSignatureMessage, verifyManifestSignature } from '../src/desktop-release.js';

/** PKCS#8 DER prefix for an Ed25519 private key; the raw 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function usage() {
  return [
    'dpx desktop manifest signing (offline)',
    '',
    '  --generate-key --out-dir <dir>          create an Ed25519 key pair',
    '  --manifest <path> --key <key>           sign a manifest in place',
    '  --manifest <path> --key <key> --out <p> write the signed manifest elsewhere',
    '  --verify --manifest <path> --public-key <key>   check an existing signature',
    '',
    '  --key        a PKCS#8 PEM file, "-----BEGIN" text, hex:<64 hex>, or base64:<32 bytes>',
    '  --public-key a "-----BEGIN PUBLIC KEY" block, base64 SPKI DER, or base64 raw 32 bytes',
    '  --key-id <id>  recorded in the manifest; defaults to a fingerprint of the public key',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { mode: 'sign' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const read = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value.`);
      index += 1;
      return value;
    };
    if (arg === '--generate-key') options.mode = 'generate';
    else if (arg === '--verify') options.mode = 'verify';
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else if (arg === '--manifest') options.manifest = read('--manifest');
    else if (arg === '--key') options.key = read('--key');
    else if (arg === '--public-key') options.publicKey = read('--public-key');
    else if (arg === '--out') options.out = read('--out');
    else if (arg === '--out-dir') options.outDir = read('--out-dir');
    else if (arg === '--key-id') options.keyId = read('--key-id');
    else throw new Error(`Unknown argument ${JSON.stringify(arg)}.\n\n${usage()}`);
  }
  return options;
}

/** Read a private key from a file, inline PEM text, a hex seed, or a base64 seed. */
function loadPrivateKey(source) {
  if (!source) throw new Error('--key is required (the private key never comes from the environment).');
  const text = source.startsWith('hex:') || source.startsWith('base64:') || source.includes('-----BEGIN')
    ? source
    : readFileSync(resolve(source), 'utf8');
  if (text.includes('-----BEGIN')) return createPrivateKey(text);
  const seed = text.startsWith('hex:')
    ? Buffer.from(text.slice(4).trim(), 'hex')
    : Buffer.from(text.replace(/^base64:/, '').trim(), 'base64');
  if (seed.length !== 32) throw new Error(`An Ed25519 seed must be 32 bytes, got ${seed.length}.`);
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** Single-line public key (base64 SPKI DER) plus its fingerprint. */
function describePublicKey(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const encoded = der.toString('base64');
  return {
    encoded,
    fingerprint: createHash('sha256').update(der).digest('hex'),
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function generateKey(options) {
  const outDir = resolve(options.outDir ?? '.');
  // A key ceremony must not fail because the operator named a new directory.
  mkdirSync(outDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const described = describePublicKey(publicKey);
  const keyPath = resolve(outDir, 'desktop-release-key.pem');
  const publicPath = resolve(outDir, 'desktop-release-pub.txt');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), { mode: 0o600 });
  writeFileSync(publicPath, `${described.encoded}\n`, 'utf8');
  process.stdout.write([
    `wrote ${keyPath} (PKCS#8 PEM, keep this offline)`,
    `wrote ${publicPath} (base64 SPKI DER, this is the distributable half)`,
    '',
    `fingerprint (sha256 of SPKI DER): ${described.fingerprint}`,
    '',
    'Distribute the public key by shipping it in assets/windows/ and publishing this',
    'fingerprint in the README and the release notes, then inject it per machine:',
    '',
    `  DPX_DESKTOP_PUBLIC_KEY=${described.encoded}`,
    '',
  ].join('\n'));
  return 0;
}

function signManifest(options) {
  if (!options.manifest) throw new Error('--manifest is required.');
  const manifestPath = resolve(options.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const privateKey = loadPrivateKey(options.key);
  const described = describePublicKey(createPublicKey(privateKey));
  const message = desktopSignatureMessage(manifest);
  const signature = cryptoSign(null, message, privateKey).toString('base64');
  const keyId = options.keyId ?? described.fingerprint.slice(0, 16);
  const signed = { ...manifest, sig: { algorithm: 'ed25519', signature, keyId } };
  const target = resolve(options.out ?? manifestPath);
  writeFileSync(target, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
  process.stdout.write([
    `signed ${target}`,
    `  version   ${manifest.version}`,
    `  assetName ${manifest.assetName}`,
    `  sha256    ${manifest.sha256}`,
    `  keyId     ${keyId}`,
    `  signature ${signature.slice(0, 24)}…`,
    '',
    `Verify with: node scripts/sign-desktop-manifest.mjs --verify --manifest ${target} --public-key ${described.encoded}`,
    '',
  ].join('\n'));
  return 0;
}

function verifyManifest(options) {
  if (!options.manifest) throw new Error('--manifest is required.');
  if (!options.publicKey) throw new Error('--public-key is required to verify.');
  const manifest = JSON.parse(readFileSync(resolve(options.manifest), 'utf8'));
  const verdict = verifyManifestSignature(manifest, { publicKey: options.publicKey });
  process.stdout.write(`${JSON.stringify({ manifest: resolve(options.manifest), ...verdict }, null, 2)}\n`);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.mode === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.mode === 'generate') return generateKey(options);
  if (options.mode === 'verify') return verifyManifest(options);
  return signManifest(options);
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`sign-desktop-manifest: ${error.message}\n`);
  process.exitCode = 1;
}
