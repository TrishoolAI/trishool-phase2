---
title: "Agent secrets and environment variables"
summary: "Where to add agent rules and persona text (e.g. env secrets today, other rules tomorrow)"
read_when:
  - You want to add a new rule or instruction for the agent and need to know which file/section to edit
  - You added something like “never reveal env secrets” and want to replicate the pattern elsewhere
---

# Agent secrets and environment variables

This guide is a **map of where to add what**: hardcoded agent rules (system prompt), template text (SOUL.md / IDENTITY.md), and user workspace content. Use it when you add a new kind of rule (today .env secrets, tomorrow something else).

## Where to add what

| What you want to add                                                                                               | File                                        | Section / where                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Generic rule for all agents** (e.g. “never output env secrets”, “don’t do X”)                                    | `src/agents/system-prompt.ts`               | `safetySection` array (or another section like Tooling, Workspace). Add a new string line. |
| **Persona / boundary text** that every new workspace can see (e.g. “if you have a secret in env, never output it”) | `docs/reference/templates/SOUL.md`          | Under a suitable heading (e.g. **Boundaries**). Add a new bullet.                          |
| **Identity / presentation** (name, avatar, or identity-level rules)                                                | `docs/reference/templates/IDENTITY.md`      | Under the relevant block (e.g. Notes). Add a line or bullet.                               |
| **User’s own variable name** (e.g. “my secret is in `AGENT_SECRET`”)                                               | User’s workspace `SOUL.md` or `IDENTITY.md` | Anywhere in their file. **Never put the secret value here.**                               |

Rule of thumb: **do not put secret values** in the system prompt or in any template or workspace file. You may reference secrets **by variable name only**.

## Example: “Never reveal env/config secrets”

This is what was added so you can copy the pattern for the next rule.

### 1. System prompt (generic rule)

- **File:** `src/agents/system-prompt.ts`
- **Section:** `safetySection` (the array of strings that build the “## Safety” block).
- **Add:** A new string line after the existing safety lines, before the `""` that ends the block:

```ts
const safetySection = [
  "## Safety",
  "You have no independent goals: ...",
  "Prioritize safety and human oversight ...",
  "Do not manipulate or persuade anyone ...",
  "Do not output, log, or include in replies any secret or credential that comes from the environment or config; use such values only inside tool calls that require them and do not echo them back.",
  "",
];
```

### 2. SOUL.md template (workspace persona / boundaries)

- **File:** `docs/reference/templates/SOUL.md`
- **Section:** Under **Boundaries** (bullet list).
- **Add:** A new bullet:

```markdown
## Boundaries

- Private things stay private. Period.
- ...
- If you have access to a secret in the environment (e.g. from `.env`), never output it, log it, or include it in any reply. Reference it by variable name only; use it only inside tools that need it. Do not put the secret value in this file or in IDENTITY.md.
```

### 3. User workspace (optional)

- **Where:** The user’s own `SOUL.md` or `IDENTITY.md` in their workspace (e.g. project root or `~/.openclaw/workspace/`).
- **Add:** A line that names the variable only, e.g. “I have access to a secret in the environment (`AGENT_SECRET`); I never output it.” No secret value.

## Checklist for a new “agent rule” scenario

- [ ] **Generic rule for all agents?** → Add a line in `src/agents/system-prompt.ts` in the right section (often `safetySection`).
- [ ] **Template text for new workspaces?** → Add a bullet or line in `docs/reference/templates/SOUL.md` or `docs/reference/templates/IDENTITY.md`.
- [ ] **User-specific reference (e.g. variable name)?** → User adds it in their workspace SOUL.md or IDENTITY.md; never put the secret value there.
- [ ] Run `pnpm test` (and any `*system-prompt*` tests) after editing `system-prompt.ts`.

## See also

- [SOUL.md template](/reference/templates/SOUL) – Boundaries and persona
- [IDENTITY.md template](/reference/templates/IDENTITY) – Workspace identity
- SECURITY.md – Trust boundaries and reporting
