import "dotenv/config";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const app = createApp(config);

  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
