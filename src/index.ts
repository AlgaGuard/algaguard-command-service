import { once } from "node:events";
import { createPostgresPool } from "./adapters.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CommandWorker } from "./domain.js";
import { PostgresCommandRepository } from "./repository.js";
import { MqttCommandTransport } from "./transport.js";

const config = loadConfig();
const repository = new PostgresCommandRepository(createPostgresPool(config));
const transport = await MqttCommandTransport.connect(repository);
const worker = new CommandWorker(repository, transport);
const workerTimer = setInterval(() => void worker.runOnce(), 250);
workerTimer.unref();
void worker.runOnce();
const server = buildApp(repository).listen(config.PORT, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      service: "algaguard-command-service",
      message: "listening",
      port: config.PORT,
    })}\n`,
  );
});
await once(server, "listening");

async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-command-service", message: "shutdown", signal })}\n`,
  );
  clearInterval(workerTimer);
  await transport.close();
  await repository.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
