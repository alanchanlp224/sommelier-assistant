/**
 * Bump patch version in package.json, package-lock.json, and public/manifest.json
 * before each production build.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function bumpPatch(version) {
  const core = version.split(/[-+]/)[0];
  const parts = core.split('.').map((p) => parseInt(p, 10));
  while (parts.length < 3) parts.push(0);
  if (parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid semver base in version: ${version}`);
  }
  parts[2] += 1;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

const pkgPath = resolve(root, 'package.json');
const lockPath = resolve(root, 'package-lock.json');
const manifestPath = resolve(root, 'public', 'manifest.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const next = bumpPatch(pkg.version);
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
if (lock.packages?.['']) {
  lock.packages[''].version = next;
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = next;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Version bumped to ${next}`);
