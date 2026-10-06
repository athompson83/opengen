# Third-party provenance

OpenGen's initial implementation is original repository code using Node.js
built-in APIs. No source has been imported from Genisys, OpenSandbox, Daytona, or
E2B. Evaluating those projects is not an implementation dependency.

The repository's original [Apache-2.0 license](../LICENSE) is preserved. This
license covers OpenGen's own contributions; it does not replace licenses of
external executables, actions, container contents, or model services.

| Component | Use and source | License / distribution boundary |
| --- | --- | --- |
| Node.js | Local runtime and workload interpreter; [nodejs/node](https://github.com/nodejs/node) | Node.js and bundled dependencies retain their [license notices](https://github.com/nodejs/node/blob/main/LICENSE) |
| Official Node.js image | Base of `images/node.Dockerfile`; [nodejs/docker-node](https://github.com/nodejs/docker-node) | Image tooling and inherited software keep their own licenses; the complete image is not relicensed Apache-2.0 |
| Debian Bookworm | Operating-system packages in the workload base image | Package-specific notices and licenses; inspect `/usr/share/doc` in the image |
| Docker Engine / CLI | Operator-supplied container execution; [Docker documentation](https://docs.docker.com/engine/) | Installed separately; OpenGen does not redistribute Docker Desktop or Docker Sandboxes |
| GitHub checkout and setup-node actions | CI only; official `actions` repositories | Each action retains its upstream license; full commits pinned in the workflow |

## Pins checked for this setup

On October 6, 2026, the [official Node.js Dockerfile](https://github.com/nodejs/docker-node/blob/main/24/bookworm-slim/Dockerfile)
listed Node.js `24.21.0`. The OpenGen image therefore uses the explicit
`node:24.21.0-bookworm-slim` tag. A registry manifest digest was not independently
retrieved during setup, so the Dockerfile deliberately does not contain an
invented digest. A version tag can still be republished. Operators who require a
reproducible supply chain should resolve and review the appropriate manifest
digest before deployment and record it in their image policy. The runtime records
the locally inspected image identity for each sandbox.

The initial CI pins were resolved from official release pages:

- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1):
  `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0):
  `820762786026740c76f36085b0efc47a31fe5020`.

Recheck licenses, upstream maintenance, release identity, compatibility, and
relevant security advisories when updating these components. Keep notices with
redistributed software. Using or integrating open-source components does not
grant rights to unrelated project trademarks.
