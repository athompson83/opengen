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

/**
 * Step-by-step tutorials: the same real recording, rendered as a guided walkthrough with a step list, captions and a
 * progress bar. Each chapter's commands run in order in one shell session, so later chapters reuse earlier results.
 */
const TUTORIALS = [
  { file: 'tutorial-first-sandbox.svg', title: 'Your first sandbox', number: 1, chapters: [
    { caption: 'Check that Docker is ready', detail: 'doctor confirms the engine and the built image.', steps: [
      'opengen doctor | jq -c \'{ready: .runtime.ready, backend: .runtime.backend}\'',
    ] },
    { caption: 'Create a sandbox', detail: 'One command; it starts locked down and offline.', steps: [
      'ID=$(opengen create hello | jq -r .id); echo $ID',
      'opengen status $ID --project hello | jq -c \'{state, network}\'',
    ] },
    { caption: 'Run a command inside', detail: 'Programs run in the container, never on your PC.', steps: [
      'opengen exec $ID --project hello -- node -p "\'Hello from \' + process.platform" | jq -r .stdout',
    ] },
    { caption: 'Write and read a file', detail: 'Files live in the sandbox workspace.', steps: [
      'opengen exec $ID --project hello -- sh -c "echo \'my first notes\' > notes.txt" | jq -c \'{exitCode}\'',
      'opengen read $ID notes.txt --project hello | jq -r .content | base64 -d',
    ] },
    { caption: 'Clean up', detail: 'Deleting the workspace is always explicit.', steps: [
      'opengen delete $ID --project hello --delete-workspace | jq -c \'{deleted}\'',
    ] },
  ] },
  { file: 'tutorial-preview-app.svg', title: 'Build and preview a web app', number: 2, chapters: [
    { caption: 'Create a sandbox with a port', detail: 'Networking is opt-in; the preview binds to 127.0.0.1.', steps: [
      'ID=$(opengen create webapp --network bridge --port 3000 | jq -r .id)',
      'URL=$(opengen status $ID --project webapp | jq -r \'.ports[0].url\'); echo $URL',
    ] },
    { caption: 'Write the app', detail: 'A tiny web server, written into the workspace.', steps: [
      'opengen exec $ID --project webapp -- node -e "require(\'fs\').writeFileSync(\'server.js\', \\"require(\'http\').createServer((q, s) => s.end(\'Hello from my sandbox app\')).listen(3000)\\")" | jq -c \'{exitCode}\'',
    ] },
    { caption: 'Start it', detail: 'Run the dev server in the background.', steps: [
      'opengen exec $ID --project webapp -- sh -c "nohup node server.js >/dev/null 2>&1 &" | jq -c \'{exitCode}\'',
    ] },
    { caption: 'Open the preview', detail: 'Visit the loopback URL in your browser.', steps: [
      'sleep 1; curl -s $URL; echo',
    ] },
  ] },
  { file: 'tutorial-from-your-app.svg', title: 'Use OpenGen from your app', number: 3, projects: ['api-demo', 'example-project'], chapters: [
    { caption: 'Authenticate', detail: 'Every call carries the owner token from init.', steps: [
      'H="Authorization: Bearer $(cat $OPENGEN_STATE_DIR/token)"; curl -s -H "$H" $OPENGEN_URL/v1/health | jq -c \'{ready: .runtime.ready}\'',
    ] },
    { caption: 'Create over HTTP', detail: 'POST /v1/sandboxes with a project id.', steps: [
      'ID=$(curl -s -H "$H" -H "Content-Type: application/json" -d \'{"projectId":"api-demo"}\' $OPENGEN_URL/v1/sandboxes | jq -r .id); echo $ID',
    ] },
    { caption: 'Run a command over HTTP', detail: 'argv is an array, never a host shell.', steps: [
      'curl -s -H "$H" -H "Content-Type: application/json" -d \'{"projectId":"api-demo","argv":["node","-p","6*7"]}\' $OPENGEN_URL/v1/sandboxes/$ID/exec | jq -c \'{exitCode, stdout}\'',
    ] },
    { caption: 'Or use the JavaScript client', detail: 'Typed client for trusted backend code.', steps: [
      'sed -n 9,12p examples/local-client.mjs',
      'node examples/local-client.mjs | jq -c \'.result | {exitCode, stdout}\'',
    ] },
  ] },
  { file: 'tutorial-lifecycle.svg', title: 'Stop, reset and keep your files', number: 4, chapters: [
    { caption: 'Save some work', detail: 'Write a file in a new sandbox.', steps: [
      'ID=$(opengen create keep | jq -r .id)',
      'opengen exec $ID --project keep -- sh -c "echo \'draft v1\' > draft.txt" | jq -c \'{exitCode}\'',
    ] },
    { caption: 'Stop and start', detail: 'Stopping frees resources; files stay.', steps: [
      'opengen stop $ID --project keep | jq -c \'{state}\'',
      'opengen start $ID --project keep | jq -c \'{state}\'',
    ] },
    { caption: 'Reset a broken sandbox', detail: 'Reset rebuilds the container, not your files.', steps: [
      'opengen reset $ID --project keep | jq -c \'{state}\'',
      'opengen read $ID draft.txt --project keep | jq -r .content | base64 -d',
    ] },
    { caption: 'List what is running', detail: 'Every sandbox belongs to a project.', steps: [
      'opengen list --project keep | jq -c \'[.[] | {state, project: .projectId}]\'',
    ] },
  ] },
];

const STATE_NAMES = ['ID', 'URL', 'H'];

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
    const vars = join(work, 'vars.sh');
    /** Runs one command in the recording's shell session, carrying ID/URL/H forward, and returns what it printed. */
    const record = (scenario, step) => {
      const script = `set -o pipefail; . "${vars}"; ${step}\n{ ${STATE_NAMES.map((name) => `[ -n "\${${name}:-}" ] && printf '%s=%q\\n' ${name} "$${name}"`).join('; ')}; } > "${vars}.next"; true`;
      const result = run('bash', ['-c', script], env);
      writeFileSync(vars, readFileSync(`${vars}.next`, 'utf8'));
      // A failed call piped through jq shows as null; an empty ID would make every later step meaningless.
      const failed = /"error":\{"code"|\bnull\b/.test(result) || /^ID=(''|null)?$/m.test(readFileSync(vars, 'utf8'));
      if (failed && !scenario.expectErrors) throw new Error(`${scenario.file}: ${step}\n${result}`);
      return { command: step, output: result.trimEnd() };
    };
    const wanted = (entry) => !only.length || only.includes(entry.file.replace(/\.svg$/, ''));
    for (const scenario of SCENARIOS.filter(wanted)) {
      current = scenario;
      writeFileSync(vars, '');
      const lines = scenario.steps.map((step) => record(scenario, step));
      writeFileSync(join(out, scenario.file), render(scenario.title, lines));
      cleanUp(scenario);
      current = null;
      console.log(`Recorded ${scenario.file}\n${lines.map((line) => `$ ${line.command}\n${line.output}`).join('\n')}\n`);
    }
    for (const tutorial of TUTORIALS.filter(wanted)) {
      const flat = { ...tutorial, steps: tutorial.chapters.flatMap((chapter) => chapter.steps) };
      current = flat;
      writeFileSync(vars, '');
      const chapters = tutorial.chapters.map((chapter) => ({ ...chapter, lines: chapter.steps.map((step) => record(flat, step)) }));
      writeFileSync(join(out, tutorial.file), renderTutorial(tutorial, chapters));
      cleanUp(flat);
      current = null;
      console.log(`Recorded ${tutorial.file}\n${chapters.map((chapter) => `## ${chapter.caption}\n${chapter.lines.map((line) => `$ ${line.command}\n${line.output}`).join('\n')}`).join('\n')}\n`);
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

// ---- Tutorials: a guided walkthrough. Steps light up on the left while each step's real session plays on the right. ----

const T = { width: 960, side: 340, top: 86, step: 74, termX: 352, termTop: 86, cols: 70, detail: 36 };

export function renderTutorial(tutorial, chapters) {
  const termWidth = T.width - T.termX - 18;
  const scenes = [];
  let time = 0.8;
  for (const chapter of chapters) {
    const start = time, rows = [];
    for (const line of chapter.lines) {
      const typed = wrap(`$ ${line.command}`, T.cols);
      const typing = Math.min(2.4, 0.028 * line.command.length + 0.35);
      typed.forEach((text, index) => rows.push({ text, kind: index === 0 ? 'prompt' : 'command', start: time + (typing * index) / typed.length, typing: typing / typed.length }));
      time += typing + 0.35;
      for (const text of line.output ? wrap(line.output, T.cols) : []) rows.push({ text, kind: 'output', start: time });
      time += 0.8;
    }
    time += 1.4;
    scenes.push({ ...chapter, start, end: time, rows });
  }
  const total = time + 1.6;
  const pct = (seconds) => ((seconds / total) * 100).toFixed(2);
  const stepsHeight = chapters.length * T.step + 24;
  const termHeight = 40 + Math.max(...scenes.map((scene) => scene.rows.length)) * LINE + 22;
  const height = T.top + Math.max(stepsHeight, termHeight) + 44;
  const styles = [];
  const keyed = (name, frames) => { styles.push(`@keyframes ${name}{${frames}}.${name}{animation:${name} ${total.toFixed(2)}s linear infinite}`); return name; };
  // The highlight slides to each step as its scene begins.
  const slide = scenes.map((scene, index) => `${pct(scene.start)}%,${pct(Math.max(scene.start, scene.end - 0.3))}%{transform:translateY(${index * T.step}px)}`).join('');
  keyed('hl', `0%{transform:translateY(0)}${slide}100%{transform:translateY(${(scenes.length - 1) * T.step}px)}`);
  const steps = scenes.map((scene, index) => {
    const y = T.top + 12 + index * T.step, on = pct(scene.start);
    const dot = keyed(`d${index}`, `0%,${on}%{fill:#30363d}${(Number(on) + 0.01).toFixed(2)}%,100%{fill:#2f81f7}`);
    const label = keyed(`l${index}`, `0%,${on}%{opacity:.55}${(Number(on) + 0.01).toFixed(2)}%,100%{opacity:1}`);
    return `<g class="${label}"><circle class="${dot}" cx="38" cy="${y + 26}" r="13"/><text x="38" y="${y + 30.5}" text-anchor="middle" class="num">${index + 1}</text>
<text x="62" y="${y + 19}" class="cap">${escape(scene.caption)}</text>${wrap(scene.detail, T.detail).slice(0, 2).map((part, line) => `<text x="62" y="${y + 38 + line * 16}" class="det">${escape(part.trim())}</text>`).join('')}</g>`;
  }).join('\n');
  const body = scenes.map((scene, sceneIndex) => {
    const last = sceneIndex === scenes.length - 1;
    const fadeIn = pct(scene.start - 0.25), shown = pct(scene.start), hide = pct(scene.end), gone = pct(scene.end + 0.25);
    const vis = keyed(`s${sceneIndex}`, last ? `0%,${fadeIn}%{opacity:0}${shown}%,100%{opacity:1}` : `0%,${fadeIn}%{opacity:0}${shown}%,${hide}%{opacity:1}${gone}%,100%{opacity:0}`);
    const lines = scene.rows.map((row, index) => {
      const y = T.termTop + 40 + 16 + index * LINE, id = `${sceneIndex}_${index}`, show = pct(row.start);
      const appear = keyed(`r${id}`, `0%,${show}%{opacity:0}${(Number(show) + 0.01).toFixed(2)}%,100%{opacity:1}`);
      if (row.kind === 'output') return `<g class="${appear}"><text x="${T.termX + 18}" y="${y}" class="out">${escape(row.text)}</text></g>`;
      const end = pct(row.start + row.typing);
      styles.push(`@keyframes t${id}{0%,${show}%{transform:scaleX(0)}${end}%,100%{transform:scaleX(1)}}.t${id}{transform-box:fill-box;transform-origin:left;animation:t${id} ${total.toFixed(2)}s linear infinite}`);
      const prompt = row.kind === 'prompt' ? `<tspan class="ps">$</tspan>${escape(row.text.slice(1))}` : escape(row.text);
      return `<g class="${appear}"><clipPath id="c${id}"><rect class="t${id}" x="${T.termX + 18}" y="${y - LINE + 5}" width="${row.text.length * CHAR + 4}" height="${LINE}"/></clipPath><text x="${T.termX + 18}" y="${y}" class="cmd" clip-path="url(#c${id})">${prompt}</text></g>`;
    }).join('\n');
    return `<g class="scene ${vis}${last ? ' last' : ''}">${lines}</g>`;
  }).join('\n');
  keyed('pg', `0%{transform:scaleX(0)}100%{transform:scaleX(1)}`);
  const label = `Tutorial ${tutorial.number}: ${tutorial.title}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${T.width}" height="${height}" viewBox="0 0 ${T.width} ${height}" role="img" aria-label="${escape(label)}. Steps: ${escape(chapters.map((chapter, index) => `${index + 1}. ${chapter.caption}`).join(' '))}. Recorded from a real OpenGen session.">
<title>${escape(label)}</title>
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#111a2e"/></linearGradient>
<linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f81f7"/><stop offset="1" stop-color="#00b4d8"/></linearGradient></defs>
<style>
text{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;white-space:pre}
.kicker{fill:#7ee0ff;font-size:12px;font-weight:700;letter-spacing:.12em}.title{fill:#f0f6fc;font-size:22px;font-weight:700}
.num{fill:#fff;font-size:13px;font-weight:700}.cap{fill:#f0f6fc;font-size:14.5px;font-weight:600}.det{fill:#9aa7b4;font-size:12.5px}
.cmd,.out{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT}px}.cmd{fill:#e6edf3}.ps{fill:#3fb950;font-weight:700}.out{fill:#8b949e}
.bar{fill:#8b949e;font-size:12px}.hlr{fill:#2f81f71f;stroke:#2f81f766}.pg{transform-origin:left;transform-box:fill-box}
${styles.join('\n')}
@media (prefers-reduced-motion: reduce){g,rect,circle{animation:none!important;opacity:1!important;transform:none!important}.scene{opacity:0!important}.scene.last{opacity:1!important}circle{fill:#2f81f7}}
</style>
<rect width="${T.width}" height="${height}" rx="14" fill="url(#bg)"/>
<text x="24" y="34" class="kicker">OPENGEN TUTORIAL ${tutorial.number}</text><text x="24" y="62" class="title">${escape(tutorial.title)}</text>
<rect class="hl hlr" x="14" y="${T.top + 6}" width="${T.side - 28}" height="${T.step - 6}" rx="12"/>
${steps}
<rect x="${T.termX}" y="${T.termTop}" width="${termWidth}" height="${termHeight}" rx="10" fill="#0d1117" stroke="#30363d"/>
<rect x="${T.termX}" y="${T.termTop}" width="${termWidth}" height="30" rx="10" fill="#161b22"/><rect x="${T.termX}" y="${T.termTop + 20}" width="${termWidth}" height="10" fill="#161b22"/>
<circle cx="${T.termX + 18}" cy="${T.termTop + 15}" r="5.5" fill="#ff5f57"/><circle cx="${T.termX + 36}" cy="${T.termTop + 15}" r="5.5" fill="#febc2e"/><circle cx="${T.termX + 54}" cy="${T.termTop + 15}" r="5.5" fill="#28c840"/>
<text x="${T.termX + termWidth / 2}" y="${T.termTop + 19}" text-anchor="middle" class="bar">recorded OpenGen session</text>
${body}
<rect x="24" y="${height - 22}" width="${T.width - 48}" height="5" rx="2.5" fill="#21262d"/><rect class="pg" x="24" y="${height - 22}" width="${T.width - 48}" height="5" rx="2.5" fill="url(#accent)"/>
</svg>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
