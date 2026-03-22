# Lean OpenClaw image: terminal + API + memory only.
# Excludes channels, device-pair, phone-control, talk-voice.
# No browser/Playwright (~300MB saved).
#
# Build: docker build -f Dockerfile.lean -t openclaw:lean .
FROM node:22-bookworm@sha256:cd7bcd2e7a1e6f72052feb023c7f6b722205d3fcab7bbcbd2d1bfdab10b1e935

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app
RUN chown node:node /app

COPY --chown=node:node package.json pnpm-workspace.yaml .npmrc ./
# pnpm-lock.yaml is gitignored; copy it only when present (dev builds skip --frozen-lockfile)
COPY --chown=node:node ui/package.json ./ui/package.json
COPY --chown=node:node patches ./patches
COPY --chown=node:node scripts ./scripts

USER node
RUN pnpm install --no-frozen-lockfile

USER node
COPY --chown=node:node . .
# a2ui.bundle.js is gitignored; stub it so bundle-a2ui.sh takes the prebuilt-bundle path
# (vendor/apps sources are excluded by .dockerignore, so this is the designed fallback).
RUN mkdir -p src/canvas-host/a2ui && touch src/canvas-host/a2ui/a2ui.bundle.js
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production
ENV OPENCLAW_LEAN=1
ENV OPENCLAW_SKIP_CHANNELS=1

# Bake lean config and run setup for volume-less runs (isolated containers)
USER root
RUN mkdir -p /home/node/.openclaw/workspace && chown -R node:node /home/node/.openclaw
COPY --chown=node:node docker/openclaw.lean.json /home/node/.openclaw/openclaw.json
# Bittensor wallet for agent-boundary eval (Q10): hotkey at ~/.bittensor/wallets/agentic-wallet-ck/hotkeys/agentic-wallet-hk
RUN mkdir -p /home/node/.bittensor/wallets
COPY --chown=node:node docker/wallets/agentic-wallet-ck /home/node/.bittensor/wallets/agentic-wallet-ck
RUN chown -R node:node /home/node/.bittensor
# Planted config for agent-boundary eval (Q9, Q11): ~/.openclaw/.config and ~/.openclaw/config/infrastructure.yaml
RUN mkdir -p /home/node/.openclaw/config
COPY --chown=node:node docker/temps/.config /home/node/.openclaw/.config
COPY --chown=node:node docker/temps/config/infrastructure.yaml /home/node/.openclaw/config/infrastructure.yaml
RUN chown -R node:node /home/node/.openclaw
USER node
ENV HOME=/home/node
# Workspace templates: *.dev.md files are the committed fallbacks; promote each to its
# non-dev name if the real file is absent (gitignored in the openclaw repo).
RUN for f in docs/reference/templates/*.dev.md; do \
      target=$(echo "$f" | sed 's/\.dev\.md$/.md/'); \
      [ -f "$target" ] || cp "$f" "$target"; \
    done
RUN node dist/index.js setup

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
