import { createClient } from '../src/client.mjs';
import { loadState } from '../src/config.mjs';

// Run in a trusted Node application process. The owner token must never be
// exposed to a web renderer, agent prompt, workload, or public application log.
const state = await loadState();
const client = createClient({ baseUrl: state.baseUrl, token: state.token });
const projectId = 'example-project';
const sandbox = await client.create({ projectId });
try {
  await client.writeFile(sandbox.id, { projectId, path: 'hello.mjs', content: 'console.log("Hello from OpenGen");\n' });
  const result = await client.exec(sandbox.id, { projectId, argv: ['node', 'hello.mjs'] });
  console.log(JSON.stringify({ sandboxId: sandbox.id, result }, null, 2));
} finally {
  // This example preserves the managed workspace. Explicit deletion is a
  // separate user action: client.remove(id, { projectId, deleteWorkspace: true }).
  await client.stop(sandbox.id, { projectId });
}
