# Security

OpenGen's initial release is a single-owner local developer runtime. It has not
received an independent security audit. It does not provide a microVM boundary
or establish safe public multi-tenant hosting.

## Intended deployment

Run the service as a trusted local process with access to a local Docker daemon
using Linux containers. The API binds to loopback and authenticates every route
with an owner bearer token. Browser `Origin` requests and unexpected `Host` values
are rejected. These checks reduce accidental browser access; they do not protect
a compromised host, a stolen token, or a malicious process with equivalent local
privileges.

Keep the token and runtime state outside workspaces. The token is created with
owner-only POSIX permissions where supported. Windows operators must also protect
the state directory with Windows filesystem permissions; a POSIX mode number is
not a substitute for a Windows ACL. Do not expose the service through a public
port, unauthenticated tunnel, or generic reverse proxy.

## Controls implemented by the Docker adapter

- Run workload processes as uid/gid `1000:1000`.
- Make the root filesystem read-only and provide managed writable workspace and
  temporary storage.
- Drop Linux capabilities and prohibit privilege escalation.
- Apply finite CPU, memory, process, execution-time, and output limits.
- Disable network access unless the operator enables it and the request selects
  an allowed network mode.
- Accept only operator-approved profiles; refuse caller-selected images, host
  mounts, environment variables, privileged flags, and Docker socket access.
- Check managed-resource ownership and project association before operations.
- Keep file transfer inside the workspace, without extracting archives onto the
  host filesystem.
- Stop a sandbox after execution timeout or aborted execution.

These controls are tested behaviors, not proof that container escape is
impossible. Docker containers share their host's Linux kernel. Keep the host,
Docker, and images maintained. Use a dedicated disposable host or a separately
evaluated stronger runtime when the risk of a hostile workload requires it.

## Important boundaries

**The token represents one owner.** Project IDs prevent mistaken targeting but
are not separate customer credentials. Do not share one runtime between mutually
untrusted users.

**Bridge networking permits outbound access.** It is not a domain allowlist or a
protection against contacting reachable host, LAN, or external services. Do not
enable it for a workload that should not reach those services. Actions performed
against external services are not undone by resetting a container.

**Preview ports serve untrusted application content.** Their loopback binding
limits network exposure, but the ports do not inherit API authentication. Do not
place secrets in an unauthenticated preview. A consumer must provide a suitable
preview origin, browser isolation, and its own access policy before remote use.

**The workspace is persistent, not a backup.** Stop and reset retain workspace
changes, including malicious or accidental changes. Explicit deletion removes the
workspace. Export important artifacts to storage managed by the consumer.

**Container limits are not full storage quotas.** A managed Docker volume can
consume host disk space. The operator must provide disk capacity limits and
monitoring appropriate to the host. Command timeouts are not job scheduling,
billing limits, or automatic expiry for an idle sandbox.

**Credentials belong outside workloads.** OpenGen does not provide a secret
vault, model key store, or credential-injection proxy. A file written into a
workspace is accessible to its workload. Never put the owner token, Docker
credentials, or unrestricted account keys there.

## Reporting a vulnerability

Use the repository's [private security advisory reporting page](https://github.com/athompson83/opengen/security/advisories/new)
if private reporting is enabled. Include the affected commit, environment,
reproduction, expected boundary, and impact. Do not include live credentials,
customer data, or exploit payloads in a public issue.

If private reporting is unavailable, open a public issue containing only a
request for a private contact channel. Do not publish vulnerability details while
requesting that channel. There is no guaranteed response-time or support SLA for
this initial release.

## Verification status

Source tests and Docker integration tests establish different evidence. See
[docs/VERIFICATION.md](docs/VERIFICATION.md) and the exact commit's CI result.
Native Windows/macOS support, independent penetration testing, hostile-kernel
isolation, and Genisys integration must not be inferred from a passing Linux test.
