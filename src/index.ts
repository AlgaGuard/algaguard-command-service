import { once } from "node:events";
import * as grpc from "@grpc/grpc-js";
import { createPostgresPool } from "./adapters.js";
import { buildApp } from "./app.js";
import { createAuthenticator } from "./auth.js";
import { createGrpcCommandAuthorizer } from "./authorization.js";
import { loadConfig } from "./config.js";
import { CommandWorker } from "./domain.js";
import { buildGrpcServer } from "./grpc-server.js";
import { PostgresCommandRepository } from "./repository.js";
import { MqttCommandTransport } from "./transport.js";

const config = loadConfig();
const repository = new PostgresCommandRepository(createPostgresPool(config));
const transport = await MqttCommandTransport.connect(repository, config);
const worker = new CommandWorker(repository, transport);
const workerTimer = setInterval(() => void worker.runOnce(), 250);
workerTimer.unref();
void worker.runOnce();
const authenticate = createAuthenticator();
const authorize = createGrpcCommandAuthorizer(
  config.ACCESS_SERVICE_GRPC_ADDRESS,
);
const server = buildApp(repository, authenticate, authorize).listen(
  config.PORT,
  () => {
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        service: "algaguard-command-service",
        message: "listening",
        port: config.PORT,
      })}\n`,
    );
  },
);
await once(server, "listening");

const grpcServer = buildGrpcServer({ repository, authorize, authenticate });
grpcServer.bindAsync(
  `0.0.0.0:${config.GRPC_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (error, port) => {
    if (error) throw error;
    process.stdout.write(
      `${JSON.stringify({ level: "info", service: "algaguard-command-service", message: "grpc listening", port })}\n`,
    );
  },
);

async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-command-service", message: "shutdown", signal })}\n`,
  );
  clearInterval(workerTimer);
  grpcServer.tryShutdown(() => {});
  await transport.close();
  await repository.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
