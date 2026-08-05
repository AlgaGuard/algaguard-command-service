import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { createAuthenticator, HttpError, type Authenticator } from "./auth.js";
import {
  createCommandAuthorizer,
  type CommandAuthorizer,
} from "./authorization.js";
import type { Command, CommandRepository } from "./domain.js";

const empty = z.object({}).strict();
const commandInput = z.discriminatedUnion("commandType", [
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("REQUEST_STATUS"),
    expiresAt: z.string().datetime(),
    parameters: empty,
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("REBOOT"),
    expiresAt: z.string().datetime(),
    parameters: empty,
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("REQUEST_PHYSICAL_UNPAIR"),
    expiresAt: z.string().datetime(),
    parameters: empty,
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("SET_INDICATOR_STATE"),
    expiresAt: z.string().datetime(),
    parameters: z
      .object({
        red: z.enum(["ON", "OFF"]),
        green: z.enum(["ON", "OFF"]),
        blue: z.enum(["ON", "OFF"]),
      })
      .strict(),
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("APPLY_PROFILE_CONFIGURATION"),
    expiresAt: z.string().datetime(),
    parameters: z
      .object({
        configurationId: z.string().uuid(),
        profileId: z.string().uuid(),
        profileVersion: z.string().min(1).max(64),
      })
      .strict(),
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("SYNC_TIME"),
    expiresAt: z.string().datetime(),
    parameters: z.object({ serverTime: z.string().datetime() }).strict(),
  }),
  z.object({
    commandId: z.string().uuid(),
    commandType: z.literal("PREPARE_OTA"),
    expiresAt: z.string().datetime(),
    parameters: z.object({ releaseId: z.string().uuid() }).strict(),
  }),
]);

export interface RouteDependencies {
  repository: CommandRepository;
  authenticate?: Authenticator;
  authorize?: CommandAuthorizer;
}

function correlationId(request: Request) {
  const supplied = request.header("x-correlation-id");
  return z.string().uuid().safeParse(supplied).data ?? randomUUID();
}

function sameRequest(command: Command, input: z.infer<typeof commandInput>) {
  return (
    command.commandType === input.commandType &&
    command.expiresAt === new Date(input.expiresAt).toISOString() &&
    JSON.stringify(command.parameters) === JSON.stringify(input.parameters)
  );
}

export function createRouter(dependencies: RouteDependencies) {
  const router = Router();
  const authenticate = dependencies.authenticate ?? createAuthenticator();
  const authorize = dependencies.authorize ?? createCommandAuthorizer();

  router.post("/devices/:id/commands", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    const deviceId = z
      .string()
      .regex(/^AG-[0-9]{6}$/)
      .parse(request.params.id);
    const input = commandInput.parse(request.body);
    if (Date.parse(input.expiresAt) <= Date.now())
      throw new HttpError(422, "Command is already expired");
    const requestCorrelationId = correlationId(request);
    const decision = await authorize(
      principal.subjectId,
      "command.create",
      deviceId,
      requestCorrelationId,
    );
    if (!decision.allowed || !decision.organizationId)
      throw new HttpError(403, "Command creation is not authorized");
    const result = await dependencies.repository.create({
      commandId: input.commandId,
      deviceId,
      organizationId: decision.organizationId,
      commandType: input.commandType,
      parameters: input.parameters,
      expiresAt: new Date(input.expiresAt).toISOString(),
      createdBy: principal.subjectId,
      correlationId: requestCorrelationId,
    });
    if (
      result.command.deviceId !== deviceId ||
      !sameRequest(result.command, input)
    )
      throw new HttpError(
        409,
        "commandId is already used for different content",
      );
    response.status(202).json(result.command);
  });

  async function authorizedCommand(request: Request) {
    const principal = await authenticate(request.header("authorization"));
    const commandId = z.string().uuid().parse(request.params.id);
    const command = await dependencies.repository.get(commandId);
    if (!command) throw new HttpError(404, "Command not found");
    const decision = await authorize(
      principal.subjectId,
      "command.read",
      command.deviceId,
      correlationId(request),
    );
    if (!decision.allowed || decision.organizationId !== command.organizationId)
      throw new HttpError(403, "Command read is not authorized");
    return command;
  }

  router.get("/commands/:id", async (request, response) =>
    response.json(await authorizedCommand(request)),
  );
  router.get("/devices/:id/commands", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    const deviceId = z
      .string()
      .regex(/^AG-[0-9]{6}$/)
      .parse(request.params.id);
    const decision = await authorize(
      principal.subjectId,
      "command.read",
      deviceId,
      correlationId(request),
    );
    if (!decision.allowed)
      throw new HttpError(403, "Command list is not authorized");
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .parse(request.query.limit);
    response.json({
      items: await dependencies.repository.list(deviceId, limit),
      page: {},
    });
  });
  return router;
}
