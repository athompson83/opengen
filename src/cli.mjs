import { readFile, stat } from 'node:fs/promises';
import { loadState, stateSummary } from './config.mjs';
import { createDockerRuntime, RuntimeError } from './docker-runtime.mjs';
import { createClient, OpenGenError } from './client.mjs';
import { startServer } from './server.mjs';
import { VERSION } from './version.mjs';

class CliError extends Error {}

const HELP = `OpenGen ${VERSION} — local Docker sandbox runtime

Usage: opengen <command> [arguments] [--state-dir <directory>]

  init                                      Create owner-only local settings and token
  doctor                                    Check the Docker engine and configured images
  serve [--allow-network]                    Start the authenticated loopback API
  create <projectId> [--profile node] [--network none|bridge] [--port 3000]
  list [--project <projectId>]
  status|start|stop|reset <id> --project <projectId>
  delete <id> --project <projectId> --delete-workspace
  exec <id> --project <projectId> [--timeout 120000] -- <program> [arguments...]
  read <id> <relative-path> --project <projectId>
  write <id> <relative-path> --project <projectId> --file <local-file>

Configuration: OPENGEN_STATE_DIR (default ~/.opengen), OPENGEN_PORT,
OPENGEN_DOCKER, OPENGEN_TOKEN. The token value is never printed.
Commands output JSON; read returns base64. --port may repeat up to five times.
Use stop or reset to preserve workspace files. Delete removes the workspace.
See README.md and SECURITY.md before enabling network access.
`;

function parse(argv) {
  const separator = argv.indexOf('--');
  const commandArgs = separator < 0 ? argv : argv.slice(0, separator);
  const execArgv = separator < 0 ? undefined : argv.slice(separator + 1);
  const positional = [];
  const options = {};
  const valued = new Set(['state-dir', 'project', 'profile', 'network', 'port', 'timeout', 'file']);
  const flags = new Set(['help', 'version', 'allow-network', 'delete-workspace']);
  for (let index = 0; index < commandArgs.length; index++) {
    const arg = commandArgs[index];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!arg.startsWith('--') || arg.includes('=')) throw new CliError('Use documented --option value arguments.');
    const name = arg.slice(2);
    if (!valued.has(name) && !flags.has(name)) throw new CliError('An unknown option was supplied. Use --help.');
    if (name !== 'port' && Object.hasOwn(options, name)) throw new CliError('An option was supplied more than once.');
    if (flags.has(name)) options[name] = true;
    else {
      const value = commandArgs[++index];
      if (!value || value.startsWith('--')) throw new CliError('An option is missing its value.');
      if (name === 'port') (options.port ??= []).push(value);
      else options[name] = value;
    }
  }
  return { command: positional.shift(), positional, options, execArgv };
}

function validateInvocation(parsed) {
  const { command, positional, options, execArgv } = parsed;
  const spec = {
    init: [0, []], doctor: [0, []], serve: [0, ['allow-network']],
    create: [1, ['profile', 'network', 'port']], list: [0, ['project']],
    status: [1, ['project']], start: [1, ['project']], stop: [1, ['project']], reset: [1, ['project']],
    delete: [1, ['project', 'delete-workspace']], exec: [1, ['project', 'timeout']],
    read: [2, ['project']], write: [2, ['project', 'file']],
  }[command];
  if (!spec) throw new CliError('Choose a documented command. Use --help.');
  if (positional.length !== spec[0]) throw new CliError('The command has missing or extra arguments. Use --help.');
  if (Object.keys(options).some((key) => !['state-dir', ...spec[1]].includes(key))) throw new CliError('An option does not apply to this command.');
  if (spec[1].includes('project') && command !== 'list' && !options.project) throw new CliError('This command requires --project <projectId>.');
  if (command === 'delete' && !options['delete-workspace']) throw new CliError('Delete requires --delete-workspace. Use stop to retain work.');
  if (command === 'write' && !options.file) throw new CliError('Write requires --file <local-file>.');
  if (command === 'exec' ? !execArgv?.length : execArgv !== undefined) throw new CliError('Use -- followed by a program and arguments only with exec.');
  if (options.timeout !== undefined && (!/^\d+$/.test(options.timeout) || Number(options.timeout) < 100 || Number(options.timeout) > 900000)) throw new CliError('Timeout must be 100–900000 milliseconds.');
  if (options.port?.some((value) => !/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)) throw new CliError('Ports must be integers from 1024 to 65535.');
}

export async function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const print = (value) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const parsed = parse(argv);
    if (parsed.options.help || argv.length === 0) { out.write(HELP); return 0; }
    if (parsed.options.version) { print({ version: VERSION }); return 0; }
    validateInvocation(parsed);
    const { command, positional, options, execArgv } = parsed;
    const state = await loadState({ stateDir: options['state-dir'], env });
    if (command === 'init') { print(stateSummary(state)); return 0; }
    const makeRuntime = () => createDockerRuntime({
      dataDir: state.stateDir, dockerPath: state.dockerPath,
      allowNetwork: options['allow-network'] || state.settings.allowNetwork,
      maxSandboxes: state.settings.maxSandboxes, profiles: state.settings.profiles,
    });
    const client = createClient({ baseUrl: state.baseUrl, token: state.token });
    if (command === 'doctor') {
      let health;
      try { health = (await client.health({ signal: AbortSignal.timeout(5000) })).runtime; }
      catch (error) {
        if (!(error instanceof OpenGenError) || !['TRANSPORT_ERROR', 'REQUEST_ABORTED'].includes(error.code)) throw error;
        const runtime = await makeRuntime();
        try { health = await runtime.health(); } finally { await runtime.close(); }
      }
      print({ ...stateSummary(state), nodeVersion: process.version, runtime: health });
      return health.ready ? 0 : 1;
    }
    if (command === 'serve') {
      const runtime = await makeRuntime();
      let api;
      try {
        api = await startServer({ runtime, token: state.token, port: state.settings.port });
        print({ service: 'opengen', version: VERSION, url: api.url, mode: 'local-single-owner', allowNetwork: options['allow-network'] || state.settings.allowNetwork });
        await new Promise((resolve) => {
          const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
        });
      } finally {
        if (api) await api.close();
        await runtime.close();
      }
      return 0;
    }
    const [id, filePath] = positional;
    const scope = { projectId: options.project };
    let result;
    switch (command) {
      case 'create': result = await client.create({ projectId: id, profile: options.profile, network: options.network, ports: options.port?.map(Number) }); break;
      case 'list': result = await client.list(scope); break;
      case 'status': result = await client.get(id, scope); break;
      case 'start': case 'stop': case 'reset': result = await client[command](id, scope); break;
      case 'delete': result = await client.remove(id, { ...scope, deleteWorkspace: true }); break;
      case 'exec': result = await client.exec(id, { ...scope, argv: execArgv, timeoutMs: options.timeout === undefined ? undefined : Number(options.timeout) }); break;
      case 'read': result = await client.readFile(id, { ...scope, path: filePath }); break;
      case 'write': {
        const info = await stat(options.file);
        if (!info.isFile() || info.size > 1048576) throw new CliError('Choose an ordinary local file of at most 1 MiB.');
        const bytes = await readFile(options.file);
        if (bytes.length > 1048576) throw new CliError('The local file exceeds 1 MiB.');
        result = await client.writeFile(id, { ...scope, path: filePath, content: bytes.toString('base64'), encoding: 'base64' });
        break;
      }
    }
    print(result);
    if (command === 'exec') return result.timedOut ? 124 : (result.exitCode === 0 ? 0 : 1);
    return 0;
  } catch (error) {
    const known = error instanceof CliError || error instanceof RuntimeError || error instanceof OpenGenError;
    err.write(`${JSON.stringify({ error: { code: known ? error.code ?? 'CLI_USAGE' : 'LOCAL_CONFIGURATION_ERROR', message: known ? error.message : 'Check local settings, file permissions, and the service address. Run doctor for Docker diagnostics.' } })}\n`);
    return 1;
  }
}
