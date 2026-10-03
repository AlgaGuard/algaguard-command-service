import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { buildGrpcServer } from "../src/grpc-server.js";
import type { Authenticator } from "../src/auth.js";
import type { CommandAuthorizer } from "../src/authorization.js";
import { MemoryCommandRepository } from "../src/domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "command_service.proto");

const authenticate: Authenticator = async (authorization) => ({
  subjectId: authorization?.replace("Bearer ", "") || "anonymous",
});

async function startServer(
  repository: MemoryCommandRepository,
  authorize: CommandAuthorizer,
) {
  const server = buildGrpcServer({ repository, authorize, authenticate });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
    );
  });
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.command.v1.CommandLookupService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  return {
    client,
    stop: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

function metadataFor(bearer: string) {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", `Bearer ${bearer}`);
  return metadata;
}

test("GetCommand returns the command when the caller's own authorization allows it", async () => {
  const repository = new MemoryCommandRepository();
  const organizationId = randomUUID();
  const { command } = await repository.create({
    commandId: randomUUID(),
    deviceId: "AG-000001",
    organizationId,
    commandType: "REQUEST_PHYSICAL_UNPAIR",
    parameters: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: "owner",
    correlationId: randomUUID(),
  });
  const authorize: CommandAuthorizer = async () => ({
    allowed: true,
    organizationId,
  });
  const { client, stop } = await startServer(repository, authorize);
  try {
    const response = await new Promise<any>((resolve, reject) => {
      client.getCommand(
        { commandId: command.commandId },
        metadataFor("owner"),
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    assert.equal(response.commandId, command.commandId);
    assert.equal(response.deviceId, "AG-000001");
    assert.equal(response.status, "QUEUED");
    assert.equal(response.reportedAt, "");
  } finally {
    await stop();
  }
});

test("GetCommand rejects when the decision's organization does not match the command's", async () => {
  const repository = new MemoryCommandRepository();
  const { command } = await repository.create({
    commandId: randomUUID(),
    deviceId: "AG-000001",
    organizationId: randomUUID(),
    commandType: "REQUEST_PHYSICAL_UNPAIR",
    parameters: {},
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: "owner",
    correlationId: randomUUID(),
  });
  const authorize: CommandAuthorizer = async () => ({
    allowed: true,
    organizationId: randomUUID(), // different organization
  });
  const { client, stop } = await startServer(repository, authorize);
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          client.getCommand(
            { commandId: command.commandId },
            metadataFor("owner"),
            (error: grpc.ServiceError, response: unknown) =>
              error ? reject(error) : resolve(response),
          );
        }),
      (error: grpc.ServiceError) => {
        assert.equal(error.code, grpc.status.PERMISSION_DENIED);
        return true;
      },
    );
  } finally {
    await stop();
  }
});

test("GetCommand reports NOT_FOUND for an unknown command", async () => {
  const repository = new MemoryCommandRepository();
  const authorize: CommandAuthorizer = async () => ({ allowed: true });
  const { client, stop } = await startServer(repository, authorize);
  try {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          client.getCommand(
            { commandId: randomUUID() },
            metadataFor("owner"),
            (error: grpc.ServiceError, response: unknown) =>
              error ? reject(error) : resolve(response),
          );
        }),
      (error: grpc.ServiceError) => {
        assert.equal(error.code, grpc.status.NOT_FOUND);
        return true;
      },
    );
  } finally {
    await stop();
  }
});
