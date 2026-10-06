import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat().filter((file) => file.endsWith('.mjs'));
}
const sources = (await Promise.all(['src', 'bin', 'scripts', 'test', 'examples'].map(files))).flat().sort();
for (const source of sources) {
  const check = spawnSync(process.execPath, ['--check', source], { cwd: root, stdio: 'inherit' });
  if (check.error || check.status !== 0) process.exit(check.status || 1);
}
console.log(`Syntax checked ${sources.length} JavaScript modules.`);
const tests = sources.filter((source) => source.startsWith(`test${process.platform === 'win32' ? '\\' : '/'}`) && source.endsWith('.test.mjs'));
const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
process.exitCode = run.error ? 1 : run.status ?? 1;
