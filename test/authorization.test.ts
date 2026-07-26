import assert from "node:assert/strict";
import test from "node:test";
import { createCommandAuthorizer } from "../src/authorization.js";

test("uses the private token endpoint while retaining the public issuer", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (
      url ===
      "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token"
    )
      return Response.json({
        access_token: "test-service-token",
        expires_in: 60,
      });
    if (url === "http://access-service:3000/v1/internal/authorizations/decide")
      return Response.json({
        allowed: true,
        organizationId: "10000000-0000-4000-8000-000000000001",
      });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  try {
    const authorize = createCommandAuthorizer({
      KEYCLOAK_ISSUER: "https://dev.algaguard.example/auth/realms/algaguard",
      KEYCLOAK_TOKEN_URL:
        "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token",
      SERVICE_CLIENT_SECRET: "test-only-secret",
      ACCESS_SERVICE_URL: "http://access-service:3000",
    });
    assert.equal(
      (
        await authorize(
          "user-a",
          "command.create",
          "AG-000001",
          "correlation-id",
        )
      ).allowed,
      true,
    );
    assert.deepEqual(calls, [
      "http://keycloak:8080/realms/algaguard/protocol/openid-connect/token",
      "http://access-service:3000/v1/internal/authorizations/decide",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
