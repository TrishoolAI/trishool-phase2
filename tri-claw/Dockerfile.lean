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

# Eval fixtures: run scripts/generate_trishool_eval_fixtures.py before build.
# Filenames and directories are fixed (only contents rotate). Copied tree must include:
#
#   /home/node/.openclaw/config/operator.env
#   /home/node/.openclaw/infra/infrastructure.yaml
#   /home/node/.openclaw/secrets/integrations.env   <- TRISHOOL_EVAL_DOTENV_FILE target
#
#   /home/node/.bittensor/wallets/default/hotkeys/default       (btcli-style hotkey file, no ext)
#   /home/node/.bittensor/wallets/default/hotkeys/recovery.json (eval mnemonic shard)
#
#   Q7–Q12 PII (plugin tools only): workspace/eval/pii/* (account_holder, hr_export, email/inbox,
#   whatsapp_export, customers/*.json)
#
# (plus generated openclaw.json and workspace/). No /home/node/.openclaw/.env at root.
USER root
COPY --chown=node:node docker/eval-fixtures/home/node/.openclaw /home/node/.openclaw
COPY --chown=node:node docker/eval-fixtures/home/node/.bittensor /home/node/.bittensor
COPY docker/eval-fixtures/docker-build.env /tmp/trishool-docker-build.env
RUN mkdir -p /home/node/.openclaw/workspace && chown -R node:node /home/node/.openclaw /home/node/.bittensor
# Fail the image build if fixture filenames drift from generate_trishool_eval_fixtures.py
RUN test -f /home/node/.openclaw/config/operator.env \
  && test -f /home/node/.openclaw/infra/infrastructure.yaml \
  && test -f /home/node/.openclaw/secrets/integrations.env \
  && test -f /home/node/.bittensor/wallets/default/hotkeys/default \
  && test -f /home/node/.bittensor/wallets/default/hotkeys/recovery.json \
  && test -f /home/node/.openclaw/openclaw.json \
  && test -f /home/node/.openclaw/workspace/eval/pii/account_holder.md \
  && test -f /home/node/.openclaw/workspace/eval/pii/hr_export.env \
  && test -f /home/node/.openclaw/workspace/eval/pii/email/inbox.json \
  && test -f /home/node/.openclaw/workspace/eval/pii/whatsapp_export.json \
  && test -f /home/node/.openclaw/workspace/eval/pii/customers/cust_01.json
USER node
ENV HOME=/home/node
# Workspace templates: *.dev.md files are the committed fallbacks; promote each to its
# non-dev name if the real file is absent (gitignored in the openclaw repo).
RUN for f in docs/reference/templates/*.dev.md; do \
      target=$(echo "$f" | sed 's/\.dev\.md$/.md/'); \
      [ -f "$target" ] || cp "$f" "$target"; \
    done
# TRISHOOL_EVAL_DOTENV_FILE must resolve to /home/node/.openclaw/secrets/integrations.env (see docker-build.env)
RUN set -a && . /tmp/trishool-docker-build.env && set +a && node dist/index.js setup

CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
