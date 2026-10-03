import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { z } from "zod";
import { createAuthenticator, HttpError, type Authenticator } from "./auth.js";
import type { CommandAuthorizer } from "./authorization.js";
import type { CommandRepository } from "./domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(here, "..", "proto", "command_service.proto");

function grpcErrorFor(error: unknown): grpc.ServiceError {
  const [code, message] =
    error instanceof HttpError
      ? ([
          error.status === 403
            ? grpc.status.PERMISSION_DENIED
            : error.status === 404
              ? grpc.status.NOT_FOUND
              : grpc.status.INVALID_ARGUMENT,
          error.message,
        ] as const)
      : ([grpc.status.INTERNAL, "Internal error"] as const);
  return Object.assign(new Error(message), {
    code,
    name: "DOMAIN_ERROR",
    details: message,
    metadata: new grpc.Metadata(),
  });
}

export interface GrpcServerDependencies {
  repository: CommandRepository;
  authorize: CommandAuthorizer;
  authenticate?: Authenticator;
}

export function buildGrpcServer(dependencies: GrpcServerDependencies) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const authenticate = dependencies.authenticate ?? createAuthenticator();
  const { repository, authorize } = dependencies;

  const server = new grpc.Server();

  server.addService(proto.algaguard.command.v1.CommandLookupService.service, {
    async getCommand(
      call: grpc.ServerUnaryCall<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      try {
        const [authorization] = call.metadata.get("authorization");
        const principal = await authenticate(
          typeof authorization === "string" ? authorization : undefined,
        );
        const commandId = z.string().uuid().parse(call.request.commandId);
        const command = await repository.get(commandId);
        if (!command) throw new HttpError(404, "Command not found");
        const [correlationId] = call.metadata.get("x-correlation-id");
        const decision = await authorize(
          principal.subjectId,
          "command.read",
          command.deviceId,
          typeof correlationId === "string" ? correlationId : "",
        );
        if (
          !decision.allowed ||
          decision.organizationId !== command.organizationId
        )
          throw new HttpError(403, "Command read is not authorized");
        callback(null, {
          commandId: command.commandId,
          deviceId: command.deviceId,
          organizationId: command.organizationId,
          commandType: command.commandType,
          parametersJson: JSON.stringify(command.parameters),
          status: command.status,
          createdAt: command.createdAt,
          expiresAt: command.expiresAt,
          createdBy: command.createdBy,
          correlationId: command.correlationId,
          reportedAt: command.reportedAt ?? "",
        });
      } catch (error) {
        callback(grpcErrorFor(error));
      }
    },
  });

  return server;
}
