import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateLocalDockerEndpoint } from '../src/runtime-policy.mjs';
import { dockerEnvironment } from '../src/docker-command.mjs';

const executable = process.env.OPENGEN_DOCKER || 'docker';
function query(args) {
  const result = spawnSync(executable, args, { env: dockerEnvironment(args), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Docker is unavailable. Start a local Linux Docker engine, then retry.');
  return result.stdout.trim();
}
try {
  const context = query(['context', 'show']);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(context)) throw new Error('Select a named local Docker context.');
  const details = JSON.parse(query(['context', 'inspect', context]));
  const endpoint = validateLocalDockerEndpoint(details[0]?.Endpoints?.docker?.Host);
  if (query(['--host', endpoint, 'info', '--format', '{{.OSType}}']) !== 'linux') throw new Error('OpenGen requires Linux containers.');
  // Only the public images directory is sent as build context.
  const args = ['--host', endpoint, 'build', '--pull', '--file', 'node.Dockerfile', '--tag', 'opengen/node:0.1.0', '.'];
  const result = spawnSync(executable, args, {
    cwd: fileURLToPath(new URL('../images', import.meta.url)), env: dockerEnvironment(args), stdio: 'inherit', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('The workload image build failed. Inspect the Docker build output.');
  console.log('Built local image opengen/node:0.1.0. Run npm run doctor next.');
} catch (error) {
  console.error(error?.name === 'RuntimeError' ? error.message : error instanceof SyntaxError ? 'Docker returned invalid context details.' : error.message);
  process.exitCode = 1;
}
