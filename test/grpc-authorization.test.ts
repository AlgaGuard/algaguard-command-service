import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createGrpcCommandAuthorizer } from "../src/authorization.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadProto(file: string) {
  const protoPath = path.resolve(here, "..", "proto", file);
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  return grpc.loadPackageDefinition(packageDefinition) as any;
}

function withFakeTokenEndpoint(
  testFn: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("/protocol/openid-connect/token"))
        return new Response(
          JSON.stringify({ access_token: "fake-token", expires_in: 300 }),
          { status: 200 },
        );
      return originalFetch(input);
    }) as typeof fetch;
    try {
      await testFn({
        SERVICE_CLIENT_SECRET: "test-secret",
        SERVICE_CLIENT_ID: "algaguard-command-service",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test(
  "createGrpcCommandAuthorizer calls Decide with a service token and maps resolvedOrganizationId",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("access_service.proto");
    const received: any[] = [];
    const organizationId = randomUUID();
    const server = new grpc.Server();
    server.addService(proto.algaguard.access.v1.AuthorizationService.service, {
      decide(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        received.push({
          request: call.request,
          authorization: call.metadata.get("authorization")[0],
          correlationId: call.metadata.get("x-correlation-id")[0],
        });
        callback(null, {
          allowed: true,
          reason: "",
          decidedAt: new Date().toISOString(),
          ttlSeconds: 5,
          resolvedOrganizationId: organizationId,
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const authorize = createGrpcCommandAuthorizer(
        `127.0.0.1:${port}`,
        environment,
      );
      const decision = await authorize(
        "owner",
        "command.read",
        "AG-000001",
        "correlation-1",
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.organizationId, organizationId);
      assert.equal(received[0]?.authorization, "Bearer fake-token");
      assert.equal(received[0]?.correlationId, "correlation-1");
      assert.equal(received[0]?.request.resourceType, 2); // device
      assert.equal(received[0]?.request.action, "command.read");
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);
