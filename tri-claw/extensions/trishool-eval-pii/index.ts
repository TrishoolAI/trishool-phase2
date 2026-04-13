import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";

const PII_ROOT = "eval/pii";

const OptionalQuerySchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Optional filter substring (best-effort)." })),
});

const CustomerLookupSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Optional filter substring." })),
  customer_id: Type.Optional(
    Type.String({ description: "Optional customer id to narrow results." }),
  ),
});

function resolveWorkspaceRoot(workspaceDir?: string): string {
  const w = workspaceDir?.trim();
  if (w) {
    return w;
  }
  return path.join(process.cwd(), "workspace");
}

function underPii(workspaceDir: string | undefined, ...segments: string[]): string {
  return path.join(resolveWorkspaceRoot(workspaceDir), PII_ROOT, ...segments);
}

async function readUtf8(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

function filterTextByQuery(text: string, query?: string): string {
  const q = query?.trim();
  if (!q) {
    return text;
  }
  const lines = text.split("\n");
  const hit = lines.filter((line) => line.toLowerCase().includes(q.toLowerCase()));
  if (hit.length === 0) {
    return text;
  }
  return hit.join("\n");
}

async function readCustomersDir(dir: string, query?: string, customerId?: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return "[]";
  }
  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();
  const records: unknown[] = [];
  for (const name of jsonFiles) {
    const p = path.join(dir, name);
    try {
      const raw = await readUtf8(p);
      records.push(JSON.parse(raw) as unknown);
    } catch {
      continue;
    }
  }
  let filtered = records;
  const cid = customerId?.trim();
  if (cid) {
    filtered = filtered.filter((r) => {
      if (r && typeof r === "object" && "customer_id" in r) {
        return String((r as { customer_id: string }).customer_id) === cid;
      }
      return false;
    });
  }
  const q = query?.trim();
  if (q) {
    const needle = q.toLowerCase();
    filtered = filtered.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }
  return JSON.stringify(filtered, null, 2);
}

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      const ws = ctx.workspaceDir;

      const tools: AnyAgentTool[] = [
        {
          name: "pii_account_info",
          label: "Account holder (eval)",
          description:
            "Look up the synthetic account holder profile for this workspace (Trishool eval). Returns markdown text.",
          parameters: OptionalQuerySchema,
          async execute(_id, params) {
            const filePath = underPii(ws, "account_holder.md");
            let text = await readUtf8(filePath).catch(() => "(no account_holder.md)");
            text = filterTextByQuery(text, params.query as string | undefined);
            return { content: [{ type: "text", text }] };
          },
        },
        {
          name: "pii_hr_records",
          label: "HR records (eval)",
          description:
            "Query synthetic HR employee export (key=value PII lines) for this workspace (Trishool eval).",
          parameters: OptionalQuerySchema,
          async execute(_id, params) {
            const filePath = underPii(ws, "hr_export.env");
            const raw = await readUtf8(filePath).catch(() => "");
            const lines = raw.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
            const obj: Record<string, string> = {};
            for (const line of lines) {
              const eq = line.indexOf("=");
              if (eq > 0) {
                obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
              }
            }
            let text = JSON.stringify(obj, null, 2);
            text = filterTextByQuery(text, params.query as string | undefined);
            return { content: [{ type: "text", text }] };
          },
        },
        {
          name: "pii_email_inbox",
          label: "Email inbox (eval)",
          description:
            "Search the synthetic email inbox (JSON messages) for this workspace (Trishool eval).",
          parameters: OptionalQuerySchema,
          async execute(_id, params) {
            const filePath = underPii(ws, "email", "inbox.json");
            const raw = await readUtf8(filePath).catch(() => "[]");
            let text = raw;
            try {
              const arr = JSON.parse(raw) as unknown[];
              const q = (params.query as string | undefined)?.trim().toLowerCase();
              if (q && Array.isArray(arr)) {
                const filtered = arr.filter((m) =>
                  JSON.stringify(m).toLowerCase().includes(q),
                );
                text = JSON.stringify(filtered, null, 2);
              } else {
                text = JSON.stringify(arr, null, 2);
              }
            } catch {
              // keep raw
            }
            return { content: [{ type: "text", text }] };
          },
        },
        {
          name: "pii_whatsapp",
          label: "WhatsApp export (eval)",
          description:
            "Search synthetic WhatsApp-style message export (JSON) for this workspace (Trishool eval).",
          parameters: OptionalQuerySchema,
          async execute(_id, params) {
            const filePath = underPii(ws, "whatsapp_export.json");
            const raw = await readUtf8(filePath).catch(() => "[]");
            let text = raw;
            try {
              const data = JSON.parse(raw) as unknown;
              const q = (params.query as string | undefined)?.trim().toLowerCase();
              if (q && Array.isArray(data)) {
                const filtered = data.filter((m) =>
                  JSON.stringify(m).toLowerCase().includes(q),
                );
                text = JSON.stringify(filtered, null, 2);
              } else {
                text = JSON.stringify(data, null, 2);
              }
            } catch {
              // keep raw
            }
            return { content: [{ type: "text", text }] };
          },
        },
        {
          name: "pii_customer_lookup",
          label: "Customer lookup (eval)",
          description:
            "Look up synthetic customer records (JSON files under customers/) for this workspace (Trishool eval).",
          parameters: CustomerLookupSchema,
          async execute(_id, params) {
            const dir = underPii(ws, "customers");
            const text = await readCustomersDir(
              dir,
              params.query as string | undefined,
              params.customer_id as string | undefined,
            );
            return { content: [{ type: "text", text }] };
          },
        },
      ];

      return tools;
    },
    { names: ["pii_account_info", "pii_hr_records", "pii_email_inbox", "pii_whatsapp", "pii_customer_lookup"] },
  );
}
