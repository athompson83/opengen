#!/usr/bin/env node
/**
 * Records the README feature demos from real sessions. It starts a private OpenGen service against the local Docker
 * daemon, runs each scenario's shell commands, and renders what actually printed as an animated terminal SVG in
 * docs/assets/readme/. Nothing in a recording is typed by hand: re-run this after a change and commit the result.
 *
 *   npm run images:build && npm run readme:record [-- quick-start local-previews]
 *
 * Name scenarios to re-record only those; each transcript is also printed so it can be checked before committing.
 *
 * Needs Docker, bash, curl and jq. It uses a temporary state directory and port, and deletes its sandboxes at the end.
 */
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'assets', 'readme');
const port = Number(process.env.OPENGEN_RECORD_PORT ?? 47931);

/** Each scenario is one terminal: the commands shown are exactly the commands run. `opengen` is bin/opengen.mjs. */
const SCENARIOS = [
  { file: 'quick-start.svg', title: 'Create a sandbox and run a command', steps: [
    'opengen doctor | jq -c \'{ready: .runtime.ready, backend: .runtime.backend, profiles}\'',
    'ID=$(opengen create demo | jq -r .id)',
    'opengen status $ID --project demo | jq -c \'{state, network, limits}\'',
    'opengen exec $ID --project demo -- node -p "process.version" | jq -c \'{exitCode, stdout}\'',
  ] },
  { file: 'secure-defaults.svg', title: 'Locked down by default', steps: [
    'ID=$(opengen create locked | jq -r .id)',
    'opengen exec $ID --project locked -- id -u | jq -r .stdout',
    'opengen exec $ID --project locked -- touch /etc/x | jq -r .stderr',
    'opengen exec $ID --project locked -- node -e "fetch(\'https://example.com\').catch(e => console.log(\'offline:\', e.cause.code))" | jq -r .stdout',
  ] },
  { file: 'persistent-workspace.svg', title: 'Workspace files survive stop, start and reset', steps: [
    'ID=$(opengen create notes | jq -r .id)',
    'opengen exec $ID --project notes -- sh -c "echo shipped > todo.txt" | jq -c \'{exitCode}\'',
    'opengen stop $ID --project notes | jq -c \'{state}\'',
    'opengen reset $ID --project notes | jq -c \'{state}\'',
    'opengen read $ID todo.txt --project notes | jq -r .content | base64 -d',
  ] },
  { file: 'bounded-commands.svg', title: 'Every command has a deadline', steps: [
    'ID=$(opengen create runaway | jq -r .id)',
    'opengen exec $ID --project runaway --timeout 2000 -- sleep 600 | jq -c \'{exitCode, timedOut, durationMs}\'',
    'opengen status $ID --project runaway | jq -c \'{state}\'',
    'opengen start $ID --project runaway | jq -c \'{state}\'',
  ] },
  { file: 'local-previews.svg', title: 'Preview a dev server on loopback', steps: [
    'ID=$(opengen create site --network bridge --port 3000 | jq -r .id)',
    'opengen exec $ID --project site -- sh -c "nohup node -e \\"require(\'http\').createServer((q, s) => s.end(\'hello from the sandbox\')).listen(3000)\\" >/dev/null 2>&1 &" | jq -c \'{exitCode}\'',
    'URL=$(opengen status $ID --project site | jq -r \'.ports[0].url\'); echo $URL',
    'sleep 1; curl -s $URL; echo',
  ] },
  { file: 'js-client.svg', title: 'Drive it from your own app', projects: ['example-project'], steps: [
    'sed -n 9,12p examples/local-client.mjs',
    'node examples/local-client.mjs | jq -c \'.result | {exitCode, stdout}\'',
  ] },
  { file: 'http-api.svg', title: 'An authenticated loopback HTTP API', expectErrors: true, steps: [
    'curl -s -H "Authorization: Bearer $(cat $OPENGEN_STATE_DIR/token)" $OPENGEN_URL/v1/health | jq -c \'{ready: .runtime.ready}\'',
    'curl -s $OPENGEN_URL/v1/health | jq -c .error.code',
    'curl -s -H "Origin: https://example.com" -H "Authorization: Bearer $(cat $OPENGEN_STATE_DIR/token)" $OPENGEN_URL/v1/health | jq -c .error.code',
  ] },
];

const STATE_NAMES = ['ID', 'URL'];

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'opengen-record-'));
  const state = join(work, 'state');
  const shim = join(work, 'bin');
  mkdirSync(shim);
  writeFileSync(join(shim, 'opengen'), `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'bin', 'opengen.mjs')}" "$@"\n`);
  chmodSync(join(shim, 'opengen'), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, OPENGEN_STATE_DIR: state, OPENGEN_PORT: String(port), OPENGEN_URL: `http://127.0.0.1:${port}` };
  execFileSync(process.execPath, [join(root, 'bin', 'opengen.mjs'), 'init'], { env, stdio: 'ignore' });
  const service = spawn(process.execPath, [join(root, 'bin', 'opengen.mjs'), 'serve', '--allow-network'], { env, stdio: 'ignore' });
  // OpenGen allows maxSandboxes (4) at once, so each scenario removes its sandboxes before the next one starts.
  const cleanUp = (scenario) => {
    for (const project of [...(scenario.projects ?? []), ...scenario.steps.map((step) => /opengen create (\S+)/.exec(step)?.[1]).filter(Boolean)]) {
      const listed = JSON.parse(run(join(shim, 'opengen'), ['list', '--project', project], env) || '[]');
      for (const { id } of Array.isArray(listed) ? listed : listed.sandboxes ?? []) run(join(shim, 'opengen'), ['delete', id, '--project', project, '--delete-workspace'], env);
    }
  };
  let current = null;
  try {
    await waitForHealth(env);
    mkdirSync(out, { recursive: true });
    const only = process.argv.slice(2);
    for (const scenario of SCENARIOS.filter((entry) => !only.length || only.includes(entry.file.replace(/\.svg$/, '')))) {
      current = scenario;
      const lines = [];
      const vars = join(work, 'vars.sh');
      writeFileSync(vars, '');
      for (const step of scenario.steps) {
        const script = `set -o pipefail; . "${vars}"; ${step}\n{ ${STATE_NAMES.map((name) => `[ -n "\${${name}:-}" ] && printf '%s=%q\\n' ${name} "$${name}"`).join('; ')}; } > "${vars}.next"; true`;
        const result = run('bash', ['-c', script], env);
        writeFileSync(vars, readFileSync(`${vars}.next`, 'utf8'));
        // A failed call piped through jq shows as null; an empty ID would make every later step meaningless.
        const failed = /"error":\{"code"|\bnull\b/.test(result) || /^ID=(''|null)?$/m.test(readFileSync(vars, 'utf8'));
        if (failed && !scenario.expectErrors) throw new Error(`${scenario.file}: ${step}\n${result}`);
        lines.push({ command: step, output: result.trimEnd() });
      }
      writeFileSync(join(out, scenario.file), render(scenario.title, lines));
      cleanUp(scenario);
      current = null;
      console.log(`Recorded ${scenario.file}\n${lines.map((line) => `$ ${line.command}\n${line.output}`).join('\n')}\n`);
    }
  } finally {
    if (current) cleanUp(current);
    service.kill('SIGTERM');
    await new Promise((done) => service.once('exit', done));
    rmSync(work, { recursive: true, force: true });
  }
}

function run(command, args, env) {
  try { return execFileSync(command, args, { env, cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }); }
  catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}`; }
}

async function waitForHealth(env) {
  const token = readFileSync(join(env.OPENGEN_STATE_DIR, 'token'), 'utf8').trim();
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${env.OPENGEN_URL}/v1/health`, { headers: { authorization: `Bearer ${token}` } })).ok) return; } catch { /* not listening yet */ }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('The OpenGen service did not become healthy.');
}

// ---- Rendering: a terminal window whose commands type out and whose output appears, looping. ----

const WIDTH = 940, FONT = 13.5, LINE = 20, CHAR = 8.1, PAD = 18, TOP = 44, COLUMNS = Math.floor((WIDTH - PAD * 2) / CHAR);
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Breaks at the last space that fits (continuation lines indented), else mid-word. */
const wrap = (text, width) => text.split('\n').flatMap((line) => {
  const parts = [];
  let rest = line;
  while (rest.length > width) {
    const room = parts.length ? width - 2 : width;
    const cut = rest.lastIndexOf(' ', room) > room / 2 ? rest.lastIndexOf(' ', room) : room;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  parts.push(rest);
  return parts.map((part, index) => (index ? `  ${part}` : part));
});

export function render(title, steps) {
  const rows = [];
  let time = 0.6;
  for (const step of steps) {
    const typed = wrap(`$ ${step.command}`, COLUMNS);
    const typing = Math.min(2.2, 0.03 * step.command.length + 0.3);
    typed.forEach((text, index) => rows.push({ text, kind: index === 0 ? 'prompt' : 'command', start: time + (typing * index) / typed.length, typing: typing / typed.length }));
    time += typing + 0.35;
    for (const text of step.output ? wrap(step.output, COLUMNS) : []) rows.push({ text, kind: 'output', start: time });
    time += 0.9;
  }
  const total = time + 3.5;
  const height = TOP + PAD + rows.length * LINE + 6;
  const pct = (seconds) => ((seconds / total) * 100).toFixed(2);
  const styles = [];
  const body = rows.map((row, index) => {
    const y = TOP + PAD + index * LINE;
    const show = pct(row.start);
    styles.push(`@keyframes r${index}{0%,${show}%{opacity:0}${(Number(show) + 0.01).toFixed(2)}%,100%{opacity:1}}.r${index}{animation:r${index} ${total.toFixed(2)}s linear infinite}`);
    let text;
    if (row.kind === 'output') text = `<text x="${PAD}" y="${y}" class="out">${escape(row.text)}</text>`;
    else {
      const prompt = row.kind === 'prompt' ? `<tspan class="ps">$</tspan>${escape(row.text.slice(1))}` : escape(row.text);
      const end = pct(row.start + row.typing);
      styles.push(`@keyframes t${index}{0%,${show}%{transform:scaleX(0)}${end}%,100%{transform:scaleX(1)}}.t${index}{transform-box:fill-box;transform-origin:left;animation:t${index} ${total.toFixed(2)}s linear infinite}`);
      text = `<clipPath id="c${index}"><rect class="t${index}" x="${PAD}" y="${y - LINE + 5}" width="${row.text.length * CHAR + 4}" height="${LINE}"/></clipPath><text x="${PAD}" y="${y}" class="cmd" clip-path="url(#c${index})">${prompt}</text>`;
    }
    return `<g class="r${index}">${text}</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escape(title)}: a recorded OpenGen terminal session">
<title>${escape(title)}</title>
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px;white-space:pre}
.cmd{fill:#e6edf3}.ps{fill:#3fb950;font-weight:700}.out{fill:#8b949e}.bar{fill:#8b949e;font-family:-apple-system,"Segoe UI",sans-serif;font-size:12.5px}
${styles.join('\n')}
@media (prefers-reduced-motion: reduce){g,rect{animation:none!important;opacity:1!important;transform:none!important}}
</style>
<rect width="${WIDTH}" height="${height}" rx="10" fill="#0d1117"/>
<rect width="${WIDTH}" height="32" rx="10" fill="#161b22"/><rect y="22" width="${WIDTH}" height="10" fill="#161b22"/>
<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/><circle cx="60" cy="16" r="6" fill="#28c840"/>
<text x="${WIDTH / 2}" y="20" text-anchor="middle" class="bar">${escape(title)}</text>
${body}
</svg>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
