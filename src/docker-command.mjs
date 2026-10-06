import { spawn } from 'node:child_process';
import { RuntimeError } from './runtime-policy.mjs';

export function dockerEnvironment(args) {
  const names = [
    'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
    'LOCALAPPDATA', 'PROGRAMDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
    'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH', 'DOCKER_API_VERSION',
  ];
  const env = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  if (args[0] === '--host') {
    for (const name of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[name];
  }
  return env;
}

/** Docker is the only host executable used by the runtime. Workload argv never enters a host shell. */
export async function runDockerCommand({ dockerPath = 'docker', args, input, signal, timeoutMs = 30_000, maxOutputBytes = 64 * 1024 }) {
  if (signal?.aborted) return { exitCode: 130, stdout: '', stderr: '', aborted: true, timedOut: false, truncated: false };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(dockerPath, args, { shell: false, windowsHide: true, env: dockerEnvironment(args), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new RuntimeError('DOCKER_UNAVAILABLE', 'The Docker executable could not be started.', 503));
      return;
    }
    const chunks = { stdout: [], stderr: [] };
    let captured = 0;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let settled = false;
    const collect = (stream) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - captured);
      if (chunk.length > remaining) truncated = true;
      if (remaining) {
        const kept = chunk.subarray(0, remaining);
        chunks[stream].push(kept);
        captured += kept.length;
      }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    // A command may exit before consuming its input. EPIPE must not crash the service.
    child.stdin.on('error', () => {});
    const abort = () => { aborted = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RuntimeError('DOCKER_UNAVAILABLE', 'The Docker executable could not be started.', 503));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: Number.isInteger(code) ? code : (timedOut ? 124 : aborted ? 130 : 1),
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        timedOut, aborted, truncated,
      });
    });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}
