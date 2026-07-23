import test from "node:test";
import assert from "node:assert/strict";
import {
  CommandWorker,
  MemoryCommandRepository,
  type Command,
  type CommandPublisher,
} from "../src/domain.js";

const input: Omit<Command, "status" | "createdAt" | "reportedAt"> = {
  commandId: "10000000-0000-4000-8000-000000000001",
  deviceId: "AG-000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  commandType: "REQUEST_STATUS",
  parameters: {},
  expiresAt: "2026-07-23T01:00:00Z",
  createdBy: "user-1",
  correlationId: "30000000-0000-4000-8000-000000000001",
};

test("command and publish intent are created atomically and duplicate commandId is stable", async () => {
  const repository = new MemoryCommandRepository();
  const first = await repository.create(input);
  const duplicate = await repository.create(input);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.command.commandId, first.command.commandId);
  assert.ok(await repository.claim(new Date("2026-07-23T00:00:00Z")));
});

test("expired commands are never published", async () => {
  const repository = new MemoryCommandRepository();
  await repository.create(input);
  let published = false;
  const worker = new CommandWorker(repository, {
    publish: async () => {
      published = true;
    },
  });
  assert.equal(await worker.runOnce(new Date("2026-07-23T02:00:00Z")), false);
  assert.equal(published, false);
  assert.equal((await repository.get(input.commandId))?.status, "EXPIRED");
});

test("offline publication is retried and survives worker reconstruction", async () => {
  const repository = new MemoryCommandRepository();
  await repository.create(input);
  let attempts = 0;
  const publisher: CommandPublisher = {
    publish: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("broker offline");
    },
  };
  assert.equal(
    await new CommandWorker(repository, publisher).runOnce(
      new Date("2026-07-23T00:00:00Z"),
    ),
    false,
  );
  assert.equal(
    await new CommandWorker(repository, publisher).runOnce(
      new Date("2026-07-23T00:00:01Z"),
    ),
    true,
  );
  assert.equal(attempts, 2);
});

test("device results are identity-bound and message-idempotent", async () => {
  const repository = new MemoryCommandRepository();
  await repository.create(input);
  const result = {
    messageId: "40000000-0000-4000-8000-000000000001",
    deviceId: "AG-000001",
    commandId: input.commandId,
    status: "SUCCEEDED" as const,
    reportedAt: "2026-07-23T00:01:00Z",
  };
  assert.equal((await repository.applyResult(result))?.status, "SUCCEEDED");
  assert.equal((await repository.applyResult(result))?.status, "SUCCEEDED");
  assert.equal(
    (
      await repository.applyResult({
        ...result,
        messageId: "40000000-0000-4000-8000-000000000003",
        status: "IN_PROGRESS",
      })
    )?.status,
    "SUCCEEDED",
  );
  assert.equal(
    await repository.applyResult({
      ...result,
      messageId: "40000000-0000-4000-8000-000000000002",
      deviceId: "AG-000002",
    }),
    undefined,
  );
});
