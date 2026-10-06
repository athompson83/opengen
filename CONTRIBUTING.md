# Contributing

Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and
[SECURITY.md](SECURITY.md) before changing runtime behavior. Preserve the existing
Apache-2.0 license and keep public runtime code independent from commercial
consumer applications.

## Development

Use Node.js 24 and the committed npm lockfile.

```sh
npm ci --ignore-scripts
npm run check
```

For changes to images, lifecycle, files, execution, or network behavior, use a
real local Linux Docker daemon:

```sh
npm run images:build
npm run test:docker
```

The integration suite creates and deletes only its own managed resources. It
does not prune Docker globally. Avoid running unreviewed changes on a daemon
containing important workloads.

## Pull requests

Explain the concrete behavior being fixed, the change, and the evidence. Identify
which checks ran on a real daemon and which used a test double. Add a focused
regression test when behavior or a security boundary changes. Documentation-only
changes do not need new implementation-mirroring tests.

Keep changes within one concern, preserve parallel work, and do not weaken an
existing boundary to make an integration test pass. An adapter must refuse an
unsupported capability instead of silently falling back to the host.

Use built-in Node.js APIs unless a dependency solves a demonstrated problem.
Review licenses and record provenance before copying third-party source. Do not
commit credentials, generated owner tokens, runtime state, logs from real users,
private repository material, or proprietary application code.

## CI cost

The verification workflow is one Ubuntu job with a 15-minute timeout, runs for
relevant source/configuration changes, and cancels superseded runs. It uses no
paid model API and publishes nothing. Add a job or matrix only to cover a
specific supported environment or concrete remaining risk.

Contributions are made under the repository's Apache-2.0 license. For security
issues, follow [SECURITY.md](SECURITY.md).
