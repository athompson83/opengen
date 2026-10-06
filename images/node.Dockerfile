# The version is verified against the official nodejs/docker-node repository.
# The build uses an explicit version tag; it is not a registry-digest pin.
# See docs/THIRD_PARTY.md before changing the base image.
FROM node:24.21.0-bookworm-slim

LABEL org.opencontainers.image.title="OpenGen Node workspace" \
      org.opencontainers.image.source="https://github.com/athompson83/opengen"

# Docker initializes a new managed volume from this directory. Both the mount
# root and HOME must be writable by the same non-root uid used by the runtime.
RUN mkdir -p /workspace/.home && chown -R 1000:1000 /workspace

ENV HOME=/workspace/.home
USER 1000:1000
WORKDIR /workspace

CMD ["node", "-e", "setInterval(() => {}, 2147483647)"]
