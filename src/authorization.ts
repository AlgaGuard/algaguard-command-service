import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  createServiceTokenProvider,
  metadataWithServiceToken,
} from "./grpc-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_PROTO_PATH = path.resolve(
  here,
  "..",
  "proto",
  "access_service.proto",
);

export interface AuthorizationDecision {
  allowed: boolean;
  organizationId?: string;
}
export type CommandAuthorizer = (
  subjectId: string,
  action: "command.create" | "command.read",
  deviceId: string,
  correlationId: string,
) => Promise<AuthorizationDecision>;

let cachedToken: { value: string; expiresAt: number } | undefined;
async function serviceToken(environment: NodeJS.ProcessEnv) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000)
    return cachedToken.value;
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const tokenUrl =
    environment.KEYCLOAK_TOKEN_URL ?? `${issuer}/protocol/openid-connect/token`;
  const secret = environment.SERVICE_CLIENT_SECRET;
  if (!secret) throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: environment.SERVICE_CLIENT_ID ?? "algaguard-command-service",
      client_secret: secret,
    }),
  });
  if (!response.ok) throw new Error("Command service authentication failed");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Service token response invalid");
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
  };
  return cachedToken.value;
}

export function createCommandAuthorizer(
  environment: NodeJS.ProcessEnv = process.env,
): CommandAuthorizer {
  const accessUrl =
    environment.ACCESS_SERVICE_URL ?? "http://access-service:3000";
  return async (subjectId, action, deviceId, correlationId) => {
    const response = await fetch(
      `${accessUrl}/v1/internal/authorizations/decide`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await serviceToken(environment)}`,
          "x-correlation-id": correlationId,
        },
        body: JSON.stringify({
          subjectId,
          action,
          resourceType: "device",
          resourceId: deviceId,
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Access authorization failed with ${response.status}`);
    return (await response.json()) as AuthorizationDecision;
  };
}

export function createGrpcCommandAuthorizer(
  address: string,
  environment: NodeJS.ProcessEnv = process.env,
  serviceToken = createServiceTokenProvider(environment),
): CommandAuthorizer {
  const packageDefinition = protoLoader.loadSync(ACCESS_PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(ACCESS_PROTO_PATH)],
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const client = new proto.algaguard.access.v1.AuthorizationService(
    address,
    grpc.credentials.createInsecure(),
  );
  return async (subjectId, action, deviceId, correlationId) => {
    const metadata = await metadataWithServiceToken(serviceToken, {
      "x-correlation-id": correlationId,
    });
    const response = await new Promise<any>((resolve, reject) => {
      client.decide(
        {
          subjectId,
          action,
          resourceType: 2, // device
          resourceId: deviceId,
        },
        metadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    return {
      allowed: response.allowed,
      ...(response.resolvedOrganizationId
        ? { organizationId: response.resolvedOrganizationId }
        : {}),
    };
  };
}
