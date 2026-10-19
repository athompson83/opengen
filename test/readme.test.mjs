import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../scripts/record-readme.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(join(root, 'README.md'), 'utf8');

test('every image and local link in the README exists', () => {
  const local = [...readme.matchAll(/(?:src|href)="([^"]+)"|\]\(([^)]+)\)/g)].map((match) => match[1] ?? match[2])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target)).map((target) => target.split('#')[0]);
  assert.ok(local.length > 10);
  for (const target of local) assert.ok(existsSync(join(root, target)), target);
});

test('each recorded feature demo is shown in the README', () => {
  const recorder = readFileSync(join(root, 'scripts', 'record-readme.mjs'), 'utf8');
  const files = [...recorder.matchAll(/file: '([\w-]+\.svg)'/g)].map((match) => match[1]);
  assert.equal(files.length, 7);
  for (const file of files) assert.ok(readme.includes(`docs/assets/readme/${file}`), file);
});

test('the recorder escapes what it recorded and keeps a reduced-motion fallback', () => {
  const svg = render('A <title> & more', [{ command: 'echo "<b>" && true', output: 'a < b & c > d' }]);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('a &lt; b &amp; c &gt; d'));
  assert.ok(svg.includes('A &lt;title&gt; &amp; more'));
  assert.match(svg, /prefers-reduced-motion: reduce/);
});
