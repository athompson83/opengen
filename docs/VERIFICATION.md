# Verification

OpenGen distinguishes three layers of evidence:

| Layer | Command or evidence | Establishes |
| --- | --- | --- |
| Source checks | `npm run check` | Syntax and unit behavior, including request/policy and API/client contracts |
| Real Docker | `npm run images:build` then `npm run test:docker` | Behavior against a local Linux Docker daemon |
| Consuming application | A separately recorded installation and end-to-end run | Actual use from Genisys or another client on that platform |

A skipped Docker test is not a passing Docker verification. An enabled Docker
test fails if Docker or the expected local image is unavailable; it must not
substitute a fake runner or host execution.

## Real Docker suite

The integration test creates disposable, individually owned sandboxes and checks:

- Non-root identity, a read-only root filesystem, dropped capabilities,
  no-new-privileges, and no host bind mount or Docker socket.
- Enforced container resource configuration and a network-disabled workload.
- File writing and reading through the 1 MiB boundary, refusal of traversal,
  symlinks and FIFOs, and project scope checks.
- File persistence after stop/start, container reset, and runtime reconstruction.
- Timeout behavior that stops the whole container, including child workloads.
- Separate workspace contents for separate projects.
- Explicit deletion acknowledgment and removal of only managed resources.
- An operator-enabled preview that binds to a dynamically assigned loopback port.

Cleanup targets only resources created by the test. It never invokes a global
Docker prune. Use a disposable development host when verifying unreviewed code.

## CI

`.github/workflows/ci.yml` contains one Ubuntu 24.04 job with a 15-minute timeout
and cancellation of superseded runs. It runs source checks and the real Docker
suite for relevant code/configuration changes on `main`, pull requests, or manual
dispatch. Documentation-only changes do not trigger this workflow.

The job has read-only repository permission, uses pinned action commits, installs
from the lockfile without lifecycle scripts, and uses no model-provider keys.
It does not push images, deploy a service, create paid infrastructure, or publish
an npm package.

Use the result attached to the commit under review. Do not treat a previous green
run as verification of later changes. First-release native Windows/macOS testing,
independent security review, and consuming-application integration remain separate
requirements. Linux container tests cannot prove that hostile code can never
escape a container.
