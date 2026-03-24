import http from "node:http";
import https from "node:https";

function parseUrl(url: string) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === "https:" ? "443" : "80"),
    path: u.pathname + u.search,
  };
}

export async function requestJson<T>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { protocol, hostname, port, path: pathname } = parseUrl(url);
    const isHttps = protocol === "https:";
    const lib = isHttps ? https : http;
    const payload =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const opts: http.RequestOptions = {
      hostname,
      port: port || (isHttps ? 443 : 80),
      path: pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
        ...(payload !== undefined ? { "Content-Length": String(Buffer.byteLength(payload, "utf8")) } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          return;
        }
        resolve(parsed as T);
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload, "utf8");
    req.end();
  });
}
