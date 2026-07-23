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
  const secret = environment.SERVICE_CLIENT_SECRET;
  if (!secret) throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
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
