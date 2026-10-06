# Local operation

Use Node.js 24 and a local Docker daemon in Linux-container mode. The source
checkout is the first-release distribution; there is no required paid application
or hosted OpenGen account.

## Setup and service

From the repository directory:

```sh
npm ci --ignore-scripts
npm run images:build
node bin/opengen.mjs init
npm run doctor
npm start
```

Keep the service running in that terminal. Use the CLI from another terminal.
`doctor` checks the environment; a missing Docker executable, stopped daemon,
wrong container OS, or missing workload image must be fixed before creating a
sandbox. OpenGen does not install Docker or run commands on the host as a fallback.

The state directory defaults to `~/.opengen`. `settings.json` holds operator
configuration and `token` holds the owner credential. Initialization does not
print that token. Do not copy the state directory into a sandbox or commit it.

```json
{
  "version": 1,
  "port": 47831,
  "allowNetwork": false,
  "maxSandboxes": 4,
  "profiles": {
    "node": {
      "image": "opengen/node:0.1.0"
    }
  }
}
```

Restart the service after changing settings. Profile images must already exist
locally and support the runtime's non-root Node.js file helpers. Treat custom
images as trusted operator configuration; arbitrary images are not accepted by
the HTTP API.

| Override | Purpose |
| --- | --- |
| `--state-dir DIR` or `OPENGEN_STATE_DIR` | Separate local state and credential location |
| `OPENGEN_PORT` | Loopback API port |
| `OPENGEN_DOCKER` | Trusted Docker executable path |
| `OPENGEN_TOKEN` | Explicit owner-token override; at least 43 allowed token characters |
| `serve --allow-network` | Enable requests for bridge networking for this service |

Use the same state directory and connection settings for the service and CLI.
Keep a token override in a secure local process environment; do not include it in
frontend code or shell commands committed to a repository.

## Create, run, and inspect

```sh
node bin/opengen.mjs create demo
node bin/opengen.mjs list --project demo
```

Copy the returned sandbox `id` into the following commands:

```sh
node bin/opengen.mjs status SANDBOX_ID --project demo
node bin/opengen.mjs exec SANDBOX_ID --project demo -- node -p "process.version"
node bin/opengen.mjs write SANDBOX_ID hello.txt --project demo --file README.md
node bin/opengen.mjs read SANDBOX_ID hello.txt --project demo
```

Commands return JSON. File reads return base64 content; the CLI does not execute
or interpret it. `write` uploads an explicitly selected local file into a
workspace-relative destination. Paths cannot select host files through the API.

Each sandbox defaults to 2 CPU units and 2048 MiB memory, with a fixed limit of
256 processes. The API can request smaller CPU/memory limits within the supported
bounds. These limits apply to each sandbox, so several active sandboxes can
compete for host resources.

```sh
node bin/opengen.mjs stop SANDBOX_ID --project demo
node bin/opengen.mjs start SANDBOX_ID --project demo
node bin/opengen.mjs reset SANDBOX_ID --project demo
```

Stop terminates processes. Reset recreates the container from its recorded image.
**Both retain workspace changes.** Neither restores a clean copy of project
files. Start relaunches the container's configured command; it does not resume
previous process memory or background jobs. A timed-out command also stops the
sandbox; explicitly start or reset it before continuing.

Deletion is intentionally explicit:

```sh
node bin/opengen.mjs delete SANDBOX_ID --project demo --delete-workspace
```

This deletes the sandbox's managed workspace as well as its container and managed
network resources. Export anything you want to keep first. It does not run a
global Docker prune.

## Local application previews

Stop the service and enable network requests when you need a preview:

```sh
node bin/opengen.mjs serve --allow-network
```

Then create a network-enabled sandbox with an allowed container port:

```sh
node bin/opengen.mjs create preview-demo --network bridge --port 3000
```

Start the application inside the sandbox and make it listen on `0.0.0.0:3000`.
The sandbox descriptor contains the dynamically assigned loopback preview URL.
It is available while the application and sandbox are running. A server running
as the foreground exec command remains subject to that command's deadline;
longer-lived development servers should be started as a supervised background
process inside the container.

Bridge mode allows outbound traffic to networks reachable from Docker. It is not
a domain allowlist. The preview is bound to loopback but has no OpenGen bearer
authentication; do not serve secrets through it. The API itself stays loopback
bound and does not accept direct browser-origin requests.

## Recovery and support scope

The service can reload persisted metadata after restart. Inspect actual status
before resuming work. A start operation can recreate a missing container only
when its recorded image and managed workspace are still available. Lost Docker
volumes require separate recovery.

Only one runtime may own a state directory at a time. A second service fails with
`RUNTIME_ALREADY_ACTIVE`; stop the existing owner instead of bypassing the lock.
Normal shutdown releases the lock after active operations finish or cancel. After
a crash, a lock is reclaimed only when it identifies this host and a confirmed
dead process. An invalid, foreign-host, or ambiguous lock is refused. Do not
delete lock files while another runtime may be active.

Stopping the API service does not stop every existing container. Explicitly stop
sandboxes first when you want all their background processes to stop. Preserve
runtime metadata so a restarted service can inspect and manage those resources.

Do not delete runtime metadata to bypass resource-ownership checks. Keep exported
project files in a separate backup system. A Docker volume can fill host storage;
per-volume disk quotas and automatic idle expiry are not implemented.

Linux CI is the first verification environment. Windows installations must use
Linux containers and satisfy Docker's virtualization requirements. Windows ACLs,
Docker Desktop variants, macOS, and alternate Docker-compatible engines require
their own compatibility checks. Remote TCP or SSH Docker contexts are refused;
the initial runtime accepts only a local Unix socket or Windows named pipe.
A successful source test does not establish native platform compatibility.
