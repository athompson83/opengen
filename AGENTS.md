# OpenGen contributor instructions

OpenGen is the independently usable, Apache-2.0 sandbox runtime. Read `README.md`,
`ARCHITECTURE.md`, `SECURITY.md`, and `PROGRESS.md` before changing its behavior.

## Public boundary

- Keep all runtime, protocol, policy enforcement, CLI, client, and verification
  code in this public repository. No paid account is required for local use.
- Do not copy proprietary application code, customer data, private configuration,
  credentials, or private repository history here. A commercial application may
  consume the public protocol or client without becoming a runtime dependency.
- Preserve LICENSE. Record third-party provenance and applicable notices.
- Do not add billing, model-provider keys, analytics, or remote account services
  to the local runtime. These belong to a separately operated client/control plane.

## Implementation

- Use Node.js ES modules, built-in APIs, npm, and the committed lockfile.
- Keep Docker behind the runtime interface. Never run workload commands on the
  host as a fallback when Docker fails.
- The initial server is a single-owner loopback service, not a public multi-tenant
  cloud service. Browser origins are rejected and every API request is authenticated.
- Only operator-configured images, managed volumes, and managed containers may be
  used. Never accept host mounts, Docker sockets, privileged mode, or daemon flags
  from an API client. Network access requires explicit operator permission.
- Inspect Git status and preserve parallel work. Give each contributor a distinct
  write surface. Integrate with fast-forward commits; never force-push over others.

## Evidence and delivery

- Run `npm run check` and the relevant behavior tests before delivery.
- Run `npm run test:docker` when a real Docker daemon is available. A fake command
  runner or unit test cannot establish container isolation or native compatibility.
- Keep CI economical: one relevant-change verification workflow, bounded runtime,
  no paid models, no deployment on documentation-only changes.
- Distinguish source tests, real container verification, and consuming-application
  integration. Do not label planned adapters or untested platforms as delivered.
- The user requested setup of this repository. Publish verified setup work to its
  main branch; do not infer authority for paid infrastructure or production services.
