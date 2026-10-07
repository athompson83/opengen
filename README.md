# OpenGen

**An independently usable, open-source execution runtime for AI applications.**

OpenGen runs commands and manages project files inside local Docker containers.
It provides a command-line interface, an authenticated loopback HTTP API, and a
small JavaScript client. Local use does not require a Genisys account, a paid
subscription, or an AI provider key.

The initial release is a **single-owner local developer runtime**. It is not an
audited security product, a microVM runtime, or a shared hosted execution service.
Read [SECURITY.md](SECURITY.md) before running untrusted workloads.

## What is included

- A Node.js execution profile with CPU, memory, and process limits.
- Non-root containers with a read-only root filesystem and a managed workspace.
- Network access disabled by default; operator-enabled bridge networking is optional.
- Workspace files that survive stop/start and container reset.
- Bounded command execution; a timed-out command stops its sandbox.
- Loopback-only preview ports when networking is explicitly enabled.
- Project-scoped lifecycle and file operations through the public API.
- A Docker integration suite in addition to source-level tests.

OpenGen does not include an AI model, hosted compute, a browser automation engine,
a graphical terminal, or remote-device connectivity. A client application can
build those experiences on the runtime. The initial backend calls Docker
directly. OpenSandbox and microVM backends are future candidates, not implemented
adapters.

## Run from source

You need Node.js 24, npm, Git, and access to a local Docker daemon running Linux
containers. Use a dedicated development environment for workloads you do not
trust. Docker Desktop users should review its separate installation and licensing
requirements; OpenGen does not redistribute Docker Desktop.

```sh
git clone https://github.com/athompson83/opengen.git
cd opengen
npm ci --ignore-scripts
npm run images:build
node bin/opengen.mjs init
npm run doctor
npm start
```

The API listens on `127.0.0.1:47831` by default. Initialization creates local
configuration and an authentication token in the OpenGen state directory. Keep
the token private; it grants access to every sandbox owned by this runtime.
The CLI uses that local configuration. See [local operation](docs/LOCAL.md) for
commands, configuration, and recovery.

The provided image build refreshes its base image and requires internet access.
Once the image is built, disconnected workloads can run with locally available
tools and files. Package downloads, remote models, and external services still
need network access and may have their own costs.

## Use from another application

The public interface supports sandbox creation, command execution, file access,
stop/start, reset, deletion, and local previews. Use the JavaScript client or the
HTTP API from a trusted local backend process. Direct browser requests are
rejected.

- [API contract](docs/API.md)
- [Client application integration](docs/INTEGRATION.md)
- [Architecture](ARCHITECTURE.md)

Genisys users can follow the [OpenGen developer guide](https://genisys.aroqon.com/developers/opengen/)
for setup and the separate developer-console connection. The console is delivered
with Genisys; this repository does not install or upgrade that application.
**OpenGen stays free and independent. Genisys Local Mode is a separate paid app
offering.** No proprietary application source or paid service is required by OpenGen.

## Verify

```sh
npm run check
npm run images:build
npm run test:docker
```

`check` verifies source behavior without a Docker daemon. `test:docker` requires a
real local Linux Docker daemon and the built image; it exercises container
configuration, lifecycle, file persistence, timeouts, project boundaries, and
preview binding. See [verification](docs/VERIFICATION.md) for what the evidence
does and does not establish.

CI runs one bounded Ubuntu job on relevant code changes. It does not run paid
models, publish images, or deploy infrastructure. Native Windows and macOS
compatibility must be validated separately; passing Linux CI is not evidence that
all desktop configurations work.

## License and contributions

OpenGen is licensed under [Apache-2.0](LICENSE). The original repository license
is preserved. See [NOTICE](NOTICE) and [third-party provenance](docs/THIRD_PARTY.md)
for external components. See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and
[SECURITY.md](SECURITY.md) to report security issues.
