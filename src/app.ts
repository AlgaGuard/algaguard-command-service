import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { z } from "zod";
import { HttpError, type Authenticator } from "./auth.js";
import type { CommandAuthorizer } from "./authorization.js";
import { MemoryCommandRepository, type CommandRepository } from "./domain.js";
import { createRouter } from "./routes.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const requestContext: RequestHandler = (request, response, next) => {
  const supplied = request.header("x-correlation-id");
  const correlationId =
    supplied && supplied.length <= 128 ? supplied : randomUUID();
  response.setHeader("x-correlation-id", correlationId);
  request.headers["x-correlation-id"] = correlationId;
  const span = trace
    .getTracer("algaguard-command-service")
    .startSpan(`${request.method} ${request.path}`);
  const startedAt = Date.now();
  response.on("finish", () => {
    logger.info(
      {
        correlationId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      },
      "request completed",
    );
    span.end();
  });
  next();
};

export function buildApp(
  repository: CommandRepository = new MemoryCommandRepository(),
  authenticate?: Authenticator,
  authorize?: CommandAuthorizer,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(requestContext);
  app.get("/health/live", (_request, response) =>
    response.json({ status: "UP", service: "algaguard-command-service" }),
  );
  app.get("/health/ready", async (_request, response) => {
    try {
      await repository.health();
      response.json({
        status: "READY",
        service: "algaguard-command-service",
        dependencies: { postgres: "UP" },
      });
    } catch {
      response.status(503).json({
        status: "NOT_READY",
        service: "algaguard-command-service",
        dependencies: { postgres: "DOWN" },
      });
    }
  });
  app.use(
    "/v1",
    createRouter({
      repository,
      ...(authenticate ? { authenticate } : {}),
      ...(authorize ? { authorize } : {}),
    }),
  );
  app.use((_request, response) =>
    response
      .status(404)
      .type("application/problem+json")
      .json({ type: "about:blank", title: "Not Found", status: 404 }),
  );
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    logger.error({ err: error }, "request failed");
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    response
      .status(status)
      .type("application/problem+json")
      .json({
        type: "about:blank",
        title:
          status === 400
            ? "Bad Request"
            : status === 401
              ? "Unauthorized"
              : status === 403
                ? "Forbidden"
                : status === 404
                  ? "Not Found"
                  : status === 409
                    ? "Conflict"
                    : status === 422
                      ? "Unprocessable Content"
                      : "Internal Server Error",
        status,
      });
  };
  app.use(errors);
  return app;
}
