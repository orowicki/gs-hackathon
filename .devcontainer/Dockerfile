# Non-root container with a default-deny egress firewall
# (pattern from Anthropic's reference devcontainer, plus the v1 fixes).
FROM node:22-bookworm-slim

ARG TZ=Etc/UTC
ENV TZ=${TZ}
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl iptables ipset iproute2 dnsutils aggregate jq sudo \
      python3 gh tzdata less procps \
      postgresql postgresql-client redis-server \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/
RUN npm install -g @anthropic-ai/claude-code rust-just

COPY init-firewall.sh /usr/local/bin/init-firewall.sh
COPY start-services.sh /usr/local/bin/start-services.sh
RUN chmod 755 /usr/local/bin/init-firewall.sh /usr/local/bin/start-services.sh \
    && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/firewall \
    && chmod 0440 /etc/sudoers.d/firewall

# v1 fix: named volumes copy ownership from the image's directory on first mount, so
# pre-create every mount point as node. Otherwise they are root-owned: login doesn't
# persist and the venv is reinstalled on every rebuild.
RUN mkdir -p /home/node/.claude /home/node/.venv /home/node/.cache/uv /workspace \
    && chown -R node:node /home/node /workspace

# No git identity here: commits use the human's identity (passed in from the host).
ENV UV_PROJECT_ENVIRONMENT=/home/node/.venv \
    UV_LINK_MODE=copy \
    UV_CACHE_DIR=/home/node/.cache/uv \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    AUTOPILOT_CONTAINER=1 \
    PATH=/home/node/.venv/bin:$PATH
USER node
