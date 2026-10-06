# HTTP API v1

Default origin: `http://127.0.0.1:47831`.

Every request, including health, requires `Authorization: Bearer <owner-token>`.
JSON requests use `Content-Type: application/json`. Requests with browser
`Origin` headers or unexpected `Host` values are refused. Call from a trusted
local backend process, not browser JavaScript.

This API serves one owner. Project IDs are scope checks within that owner's
runtime; they are not independent user accounts or tenant credentials.

## Routes

| Method | Path | Input |
| --- | --- | --- |
| `GET` | `/v1/health` | None |
| `GET` | `/v1/sandboxes` | Optional `projectId` query |
| `POST` | `/v1/sandboxes` | Create body below |
| `GET` | `/v1/sandboxes/:id` | Required `projectId` query |
| `DELETE` | `/v1/sandboxes/:id` | Required `projectId` and `deleteWorkspace=true` queries |
| `POST` | `/v1/sandboxes/:id/start` | `{ "projectId": "demo" }` |
| `POST` | `/v1/sandboxes/:id/stop` | `{ "projectId": "demo" }` |
| `POST` | `/v1/sandboxes/:id/reset` | `{ "projectId": "demo" }` |
| `POST` | `/v1/sandboxes/:id/exec` | Execution body below |
| `GET` | `/v1/sandboxes/:id/files` | Required workspace-relative `path` and `projectId` queries |
| `PUT` | `/v1/sandboxes/:id/files` | File body below |

Percent-encode path and query values. Every individual sandbox request must carry
the matching project ID. A mismatched project is treated as not found.

## Create

```json
{
  "projectId": "demo",
  "profile": "node",
  "network": "none",
  "ports": [],
  "limits": {
    "memoryMb": 512,
    "cpus": 1
  }
}
```

Creation starts the sandbox. The built-in profile uses the locally built
`opengen/node:0.1.0` image. The operator configures available profiles; a client
cannot supply an arbitrary image, environment, host mount, Docker socket, daemon
flag, or privileged mode.

Memory defaults to 2048 MiB and CPU to 2 units. Clients may request 256–2048 MiB
and 0.25–2 CPU units through `memoryMb` and `cpus`. The process limit is fixed at
256 and is not a request field. Use lower memory/CPU values on a small host.
These limits do not reserve or guarantee that the host has enough capacity.

Network mode defaults to `none`. `bridge` requires operator opt-in. Up to five
different TCP container ports from 1024 to 65535 can be requested with bridge
networking. Clients cannot choose a host bind address or host port. Preview
descriptors contain `containerPort`, `hostPort`, and the `127.0.0.1` URL.

A sandbox descriptor includes identity, project, profile, resolved image identity,
limits, network, state, and managed resource references. Status is reconciled
with Docker. Handle `running`, `stopped`, `missing`, and `error` explicitly.

## Execute

```json
{
  "projectId": "demo",
  "argv": ["node", "-p", "process.version"],
  "cwd": ".",
  "timeoutMs": 120000
}
```

`argv` is an array, not a host shell command. A workload may explicitly invoke a
shell inside its container. `cwd` is relative to `/workspace`. The timeout defaults
to 120000 milliseconds and accepts 100–900000 milliseconds. Combined command
arguments are limited to 64 KiB; captured execution output is limited to 1 MiB.

The execution result contains `exitCode`, `stdout`, `stderr`, `timedOut`,
`truncated`, and `durationMs`. A nonzero workload exit code is a command result;
an invalid API request or runtime failure is an HTTP error. Check both.

On timeout, the runtime stops the entire sandbox, including other processes. An
aborted execution also stops its sandbox. No host execution fallback occurs.
Clients must explicitly decide whether to restart, inspect artifacts, or retry;
do not blindly retry commands that might have reached external services.

## Files

```json
{
  "projectId": "demo",
  "path": "notes/hello.txt",
  "content": "Hello from OpenGen\n",
  "encoding": "utf8"
}
```

Files are limited to 1 MiB per operation. Writes support `utf8` and `base64`;
successful writes return path and byte count.
Reads return `{ "path": "...", "content": "...", "encoding": "base64" }`.
Decode the content explicitly. Absolute paths, workspace traversal, and unsafe
file paths are rejected. File access requires a running sandbox because it uses
the container's file helper rather than host archive extraction.

Workspace contents persist across stop/start, reset, and runtime process restart.
Reset replaces the container; it does not restore workspace contents. Deletion
requires `deleteWorkspace=true` and removes the workspace. Important artifacts
need separate consumer-managed storage and backups.

## Errors and versioning

Handle non-2xx responses as errors. Error responses contain an `error` object with
`code`, `message`, and `requestId`. Request validation, authentication,
project/resource ownership, unavailable Docker, missing images, and workload
state are separate failure conditions; do not translate them into a generic
successful result. Do not display tokens or raw authorization headers in errors.

The `/v1` path establishes the initial contract. Additive descriptor fields may
appear; consumers should not depend on object key order. There is no distributed
operation idempotency key, event stream, terminal PTY API, or remote preview
authentication in this release.
