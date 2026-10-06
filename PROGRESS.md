# Progress

## 2026-10-06 — Initial standalone source baseline

OpenGen provides a local Docker runtime, CLI, authenticated loopback HTTP API,
JavaScript client with TypeScript declarations, a non-root Node workspace image,
and contributor/operator documentation. It is independently usable without
Genisys, a subscription, a provider key, or a hosted service. The repository's
original Apache-2.0 license is unchanged.

The initial backend is native Docker. Execution, workspace files, lifecycle,
resource controls, project scope, local previews, state recovery, and shutdown
draining are implemented. Consumer billing, connected accounts, model inference,
and proprietary application code remain outside this repository.

### Verification before publication

- `npm run check`: 22 JavaScript modules pass syntax checks; 40 tests pass.
- An actual CLI process initialized state, served authenticated health, reported
  missing Docker accurately, and exited cleanly on SIGTERM with its lock released
  and its credential absent from output.
- One real Docker integration test is explicitly skipped in a workspace without
  a Docker daemon. This is not Docker verification.
- The public file review found no private application source, credentials, or
  production configuration in the proposed repository contents.
- A separate code review exercised the HTTP credential boundary and shutdown
  behavior. Findings concerning ownership locks, cancellation, proxy credential
  injection, and Docker endpoint pinning were corrected with regression coverage.
- The original `LICENSE` has no diff.

The GitHub Actions workflow must establish actual Docker behavior for the source
commit. It builds the workload image and runs the public API/SDK integration suite
against a local Linux Docker daemon, including proxy-setting isolation.

### Scope that remains separate

Native Windows/macOS installation verification, an independent security audit,
and wiring the client into a Genisys release are not established by source tests
or Linux CI. OpenSandbox adapters, microVM isolation, hosted multi-tenant
execution, storage quotas, remote preview authentication, and automatic expiry
are not implemented. See `docs/INTEGRATION.md`, `docs/VERIFICATION.md`, and
`SECURITY.md` for these boundaries.
