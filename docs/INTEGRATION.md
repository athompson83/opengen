# Integrating a client application

OpenGen is independently usable. A free application or a commercial application,
including Genisys, can consume the same public interface. No application-specific
account, billing module, model-provider key, or proprietary source is required by
the runtime.

**This release does not modify or wire OpenGen into an installed Genisys build.**
The JavaScript client and HTTP contract are the integration deliverables here.

## JavaScript example

Run the local service first. From the repository root, an ES module can use the
client without any runtime npm dependency:

```js
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient } from './src/client.mjs';

const stateDir = process.env.OPENGEN_STATE_DIR || join(homedir(), '.opengen');
const token = process.env.OPENGEN_TOKEN ||
  (await readFile(join(stateDir, 'token'), 'utf8')).trim();
const client = createClient({ baseUrl: 'http://127.0.0.1:47831', token });

const sandbox = await client.create({ projectId: 'integration-demo', profile: 'node' });
try {
  await client.writeFile(sandbox.id, {
    projectId: 'integration-demo',
    path: 'hello.mjs',
    content: 'console.log("Hello from an isolated workspace");\n',
    encoding: 'utf8',
  });
  const result = await client.exec(sandbox.id, {
    projectId: 'integration-demo',
    argv: ['node', 'hello.mjs'],
    timeoutMs: 10000,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error('The sandbox command did not complete successfully');
  }
  console.log(result.stdout);
} finally {
  // This example deletes only the sandbox it just created and its demo files.
  await client.remove(sandbox.id, {
    projectId: 'integration-demo',
    deleteWorkspace: true,
  });
}
```

Use the actual configured port if it differs. A consumer should load connection
details and credentials in its trusted backend. Do not ship the token into a web
bundle or an embedded page. The token grants access to every project of this
runtime owner, so an application must enforce its own user authorization before
forwarding requests.

## Consumer responsibilities

| Concern | Responsibility |
| --- | --- |
| Onboarding | Check Docker, image, permission, and capacity readiness; report actionable errors |
| Project continuity | Store task state, conversation, artifact references, and checkpoints outside a disposable container |
| Safe execution | Set limits, inspect results, handle stopped/missing state, and avoid blind retries |
| Secrets and connected accounts | Keep owner and service credentials out of workload files and logs |
| Preview UX | Treat output as untrusted content and provide browser/origin isolation |
| Remote access | Build a separately authenticated transport and authorization model before exposing local execution |
| Business controls | Enforce model budgets, service permissions, billing, and user entitlements outside OpenGen |

The free local option covers runtime software and use of the operator's own
compute. It does not include model inference, always-on cloud resources, paid
connectors, or support for arbitrary self-hosted configurations.

## Adapter boundary

The current Docker adapter supplies health, list/create/get, start/stop/reset,
remove, exec, readFile, and writeFile. A future backend should declare its network,
preview, persistence, timeout, file-transfer, and isolation capabilities rather
than silently weakening behavior to fit the interface.

OpenSandbox, gVisor/Kata, and hosted microVM providers are design candidates.
There is no implementation or operational support commitment for those backends
in this release. Do not advertise them as selectable options until code and
backend-specific verification are present.
