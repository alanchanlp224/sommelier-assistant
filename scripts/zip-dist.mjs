/**
 * Zip the dist/ folder for "Load unpacked" distribution (works on macOS and Windows).
 */
import { createWriteStream } from 'node:fs';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');
const outZip = resolve(root, 'sommelier-assistant.zip');

if (!existsSync(distDir)) {
  console.error('dist/ not found. Run npm run build first.');
  process.exit(1);
}

/** Collect files under dir; skip .map (match prior zip -x '*.map'). */
function collectFiles(dir, baseDir = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...collectFiles(abs, baseDir));
    } else if (!abs.endsWith('.map')) {
      out.push({ abs, rel: relative(baseDir, abs) });
    }
  }
  return out;
}

const files = collectFiles(distDir);
if (files.length === 0) {
  console.error('dist/ is empty.');
  process.exit(1);
}

await new Promise((resolvePromise, reject) => {
  const output = createWriteStream(outZip);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', () => {
    console.log(`Wrote ${outZip} (${archive.pointer()} bytes, ${files.length} files)`);
    resolvePromise();
  });
  archive.on('error', reject);
  archive.pipe(output);
  for (const { abs, rel } of files) {
    archive.file(abs, { name: rel.split('\\').join('/') });
  }
  archive.finalize();
});
