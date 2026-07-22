import { once } from "node:events";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { store } from "./routes.js";
import { startCommandTransport } from "./transport.js";
const config = loadConfig();
const server = buildApp().listen(config.PORT, () => {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "algaguard-command-service",
      message: "listening",
      port: config.PORT,
    }) + "\n",
  );
});
await once(server, "listening");
const mqttClient = await startCommandTransport(store);
async function shutdown(signal: string) {
  process.stdout.write(
    JSON.stringify({
      level: "info",
      service: "algaguard-command-service",
      message: "shutdown",
      signal,
    }) + "\n",
  );
  if (mqttClient) await mqttClient.endAsync();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
