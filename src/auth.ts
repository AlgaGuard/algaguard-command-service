import { createRemoteJWKSet, jwtVerify } from "jose";

export interface Principal {
  subjectId: string;
}
export type Authenticator = (
  authorization: string | undefined,
) => Promise<Principal>;
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createAuthenticator(
  environment: NodeJS.ProcessEnv = process.env,
): Authenticator {
  const issuer =
    environment.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const audience = environment.KEYCLOAK_AUDIENCE ?? "algaguard-api";
  const jwks = createRemoteJWKSet(
    new URL(`${issuer}/protocol/openid-connect/certs`),
  );
  return async (authorization) => {
    const token = /^Bearer ([^ ]+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw new HttpError(401, "Bearer token required");
    try {
      const verified = await jwtVerify(token, jwks, { issuer, audience });
      if (!verified.payload.sub || verified.payload.sub.length > 120)
        throw new HttpError(401, "Token subject is invalid");
      return { subjectId: verified.payload.sub };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(401, "Bearer token is invalid");
    }
  };
}
