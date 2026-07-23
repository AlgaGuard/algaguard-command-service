import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { CommandWorker } from "../src/domain.js";
import { PostgresCommandRepository } from "../src/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "command, outbox retry, and idempotent result survive repository restarts",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const cleanup = new pg.Pool({ connectionString: databaseUrl });
    await cleanup.query(
      "TRUNCATE command_results,command_transitions,command_outbox,commands",
    );
    await cleanup.end();
    const commandId = "10000000-0000-4000-8000-000000000001";
    const first = new PostgresCommandRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    await first.create({
      commandId,
      deviceId: "AG-000001",
      organizationId: "20000000-0000-4000-8000-000000000001",
      commandType: "REQUEST_STATUS",
      parameters: {},
      expiresAt: "2099-07-23T01:00:00Z",
      createdBy: "user-1",
      correlationId: "30000000-0000-4000-8000-000000000001",
    });
    await first.close();

    const restarted = new PostgresCommandRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    assert.equal((await restarted.get(commandId))?.status, "QUEUED");
    await new CommandWorker(restarted, {
      publish: async () => {
        throw new Error("broker offline");
      },
    }).runOnce(new Date("2098-07-23T00:00:00Z"));
    await restarted.close();

    const recovered = new PostgresCommandRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    let publications = 0;
    assert.equal(
      await new CommandWorker(recovered, {
        publish: async () => {
          publications += 1;
        },
      }).runOnce(new Date("2098-07-23T00:00:01Z")),
      true,
    );
    assert.equal(publications, 1);
    const result = {
      messageId: "40000000-0000-4000-8000-000000000001",
      commandId,
      deviceId: "AG-000001",
      status: "SUCCEEDED" as const,
      reportedAt: "2026-07-23T00:01:00Z",
    };
    await recovered.applyResult(result);
    await recovered.applyResult(result);
    assert.equal((await recovered.get(commandId))?.status, "SUCCEEDED");
    const count = await recovered.pool.query(
      "SELECT count(*)::int AS count FROM command_results",
    );
    assert.equal(count.rows[0]?.count, 1);
    await recovered.close();
  },
);
