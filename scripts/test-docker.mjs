import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const run = spawnSync(process.execPath, ['--test', 'test/docker.integration.test.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, OPENGEN_DOCKER_TESTS: '1' },
});
process.exitCode = run.error ? 1 : run.status ?? 1;
