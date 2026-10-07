# Progress

## 2026-10-07 — Developer-portal discovery

The README and client-integration guide now link the live
[Genisys OpenGen setup page](https://genisys.aroqon.com/developers/opengen/).
They distinguish the free independent runtime from Genisys's paid Local Mode
and explain that the native console is distributed with the Genisys application.
This documentation update does not change runtime, image, protocol or tests;
the verified standalone implementation below remains the same. No private
application source or release history is included here.

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

### Verification

- `npm run check`: 22 JavaScript modules pass syntax checks; 40 tests pass.
- An actual CLI process initialized state, served authenticated health, reported
  missing Docker accurately, and exited cleanly on SIGTERM with its lock released
  and its credential absent from output.
- Local source checks explicitly skip the real Docker integration test when no
  daemon is present. The real-container evidence comes from CI below.
- The public file review found no private application source, credentials, or
  production configuration in the proposed repository contents.
- A separate code review exercised the HTTP credential boundary and shutdown
  behavior. Findings concerning ownership locks, cancellation, proxy credential
  injection, and Docker endpoint pinning were corrected with regression coverage.
- The original `LICENSE` has no diff.

The [GitHub Actions run](https://github.com/athompson83/opengen/actions/runs/37482496077)
for source commit
[`22de01c48f887cc8623a1f25982480c70b5c6ff2`](https://github.com/athompson83/opengen/commit/22de01c48f887cc8623a1f25982480c70b5c6ff2)
completed successfully on Ubuntu 24.04 with Node.js 24.21.0. It built the workload
image, passed all 40 source tests, and passed all 8 reported Docker tests (seven
integration scenarios plus the enclosing test), with zero Docker failures or
skips. The implementation and verification files in this documentation update
are identical to that verified source commit.

The real Docker suite verifies actual container identity and configuration,
proxy-setting isolation, 1 MiB binary transfer with a nested Unicode/emoji
filename, unsafe file rejection, project separation, persistent workspaces,
runtime restart, timeout cleanup of detached child processes, loopback previews,
and explicit owned-resource deletion. A separate deterministic stream check
confirmed that partial multibyte input is decoded without corrupting filenames.

### Scope that remains separate

Native Windows/macOS installation verification, an independent security audit,
and wiring the client into a Genisys release are not established by source tests
or Linux CI. OpenSandbox adapters, microVM isolation, hosted multi-tenant
execution, storage quotas, remote preview authentication, and automatic expiry
are not implemented. See `docs/INTEGRATION.md`, `docs/VERIFICATION.md`, and
`SECURITY.md` for these boundaries.
