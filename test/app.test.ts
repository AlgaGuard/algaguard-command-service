import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../src/app.js";
import type { Authenticator } from "../src/auth.js";
import type { CommandAuthorizer } from "../src/authorization.js";
import { MemoryCommandRepository } from "../src/domain.js";

const authenticate: Authenticator = async (authorization) => ({
  subjectId: authorization === "Bearer denied" ? "denied" : "operator",
});
const authorize: CommandAuthorizer = async (subjectId) =>
  subjectId === "denied"
    ? { allowed: false }
    : {
        allowed: true,
        organizationId: "20000000-0000-4000-8000-000000000001",
      };
const app = () =>
  buildApp(new MemoryCommandRepository(), authenticate, authorize);
test("liveness and correlation middleware are available", async () => {
  const response = await request(app())
    .get("/health/live")
    .set("x-correlation-id", "test-correlation");
  assert.equal(response.status, 200);
  assert.equal(response.body.service, "algaguard-command-service");
  assert.equal(response.headers["x-correlation-id"], "test-correlation");
});
test("unknown routes use problem details", async () => {
  const response = await request(app()).get("/missing");
  assert.equal(response.status, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /application\/problem\+json/,
  );
});

test("authenticated and authorized HTTPS creates an outbox-backed command", async () => {
  const instance = app();
  const body = {
    commandId: "10000000-0000-4000-8000-000000000001",
    commandType: "REQUEST_STATUS",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    parameters: {},
  };
  const denied = await request(instance)
    .post("/v1/devices/AG-000001/commands")
    .set("authorization", "Bearer denied")
    .send(body);
  assert.equal(denied.status, 403);
  const created = await request(instance)
    .post("/v1/devices/AG-000001/commands")
    .set("authorization", "Bearer operator")
    .send(body);
  assert.equal(created.status, 202);
  assert.equal(created.body.status, "QUEUED");
  const duplicate = await request(instance)
    .post("/v1/devices/AG-000001/commands")
    .set("authorization", "Bearer operator")
    .send(body);
  assert.equal(duplicate.body.commandId, created.body.commandId);
});

test("command reads are denied across authorization boundaries", async () => {
  const instance = app();
  const body = {
    commandId: "10000000-0000-4000-8000-000000000002",
    commandType: "REBOOT",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    parameters: {},
  };
  await request(instance)
    .post("/v1/devices/AG-000001/commands")
    .set("authorization", "Bearer operator")
    .send(body);
  assert.equal(
    (
      await request(instance)
        .get(`/v1/commands/${body.commandId}`)
        .set("authorization", "Bearer denied")
    ).status,
    403,
  );
});
