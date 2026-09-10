import { cp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist');
// Only remove this project's literal output directory, never a symlink or parent.
if (dirname(output) !== root || output !== resolve(root, 'dist')) throw new Error('Unsafe output directory');
const previous = await lstat(output).catch((error) => { if (error.code !== 'ENOENT') throw error; });
if (previous?.isSymbolicLink()) throw new Error('Refusing to clean a symlinked output directory');
if (previous) await rm(output, { recursive: true });
await mkdir(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'script.js', 'nebula.js', 'releases.js', 'CNAME', '.nojekyll', 'favicon.ico', 'favicon.png', 'apple-touch-icon.png']) {
  await cp(resolve(root, file), resolve(output, file));
}
const html = await readFile(resolve(output, 'index.html'), 'utf8');
await mkdir(resolve(output, 'assets'), { recursive: true });
const assets = new Set([...html.matchAll(/(?:src|href)="((?:assets\/)[^"]+)"/g)].map((match) => match[1]));
for (const path of assets) {
  if (dirname(resolve(root, path)) !== resolve(root, 'assets')) throw new Error('Unexpected asset path');
  await cp(resolve(root, path), resolve(output, path));
}
await writeFile(resolve(output, 'robots.txt'), 'User-agent: *\nAllow: /\n');
console.log('Built the static site in dist/. All referenced local assets exist.');
