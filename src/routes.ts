import { Router } from "express";
import { z } from "zod";
import { CommandStore } from "./domain.js";
import { publishCommand } from "./transport.js";
export const router = Router();
export const store = new CommandStore();
router.post("/devices/:id/commands", (request, response) => {
  const input = z
    .object({
      type: z.enum(["SET_INDICATOR_STATE", "APPLY_PROFILE", "REQUEST_STATUS"]),
      payload: z.record(z.string(), z.unknown()).default({}),
      expiresAt: z.string().datetime(),
      deduplicationKey: z.string().min(1),
    })
    .parse(request.body);
  response
    .status(201)
    .json(
      store.create(
        request.params.id,
        input.type,
        input.payload,
        Date.parse(input.expiresAt),
        input.deduplicationKey,
      ),
    );
});
router.post("/commands/:id/publish", async (request, response) => {
  const result = store.publish(request.params.id);
  if (!result) return response.status(404).json({ status: 404 });
  if (result.status === "PUBLISHED") await publishCommand(result);
  return response.json(result);
});
router.get("/commands/:id", (request, response) => {
  const result = store.get(request.params.id);
  response.status(result ? 200 : 404).json(result ?? { status: 404 });
});
router.get("/commands", (_request, response) =>
  response.json({ items: store.list() }),
);
