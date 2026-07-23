import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Command,
  CommandRepository,
  CommandStatus,
  CommandType,
  DeviceResult,
  OutboxItem,
} from "./domain.js";
import { canTransition } from "./domain.js";

function commandFrom(row: Record<string, unknown>): Command {
  return {
    commandId: String(row.id),
    deviceId: String(row.device_id),
    organizationId: String(row.organization_id),
    commandType: String(row.type) as CommandType,
    parameters: row.payload as Record<string, unknown>,
    status: String(row.status) as CommandStatus,
    createdAt: new Date(row.created_at as Date | string).toISOString(),
    expiresAt: new Date(row.expires_at as Date | string).toISOString(),
    createdBy: String(row.created_by),
    correlationId: String(row.correlation_id),
    reportedAt: row.reported_at
      ? new Date(row.reported_at as Date | string).toISOString()
      : null,
  };
}

export class PostgresCommandRepository implements CommandRepository {
  constructor(readonly pool: pg.Pool) {}

  async create(input: Omit<Command, "status" | "createdAt" | "reportedAt">) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO commands(
          id,device_id,type,payload,status,expires_at,deduplication_key,
          organization_id,created_by,correlation_id)
         VALUES($1::uuid,$2,$3,$4::jsonb,'QUEUED',$5,$1::text,$6,$7,$8)
         ON CONFLICT(id) DO NOTHING RETURNING *`,
        [
          input.commandId,
          input.deviceId,
          input.commandType,
          JSON.stringify(input.parameters),
          input.expiresAt,
          input.organizationId,
          input.createdBy,
          input.correlationId,
        ],
      );
      let row = inserted.rows[0] as Record<string, unknown> | undefined;
      if (row) {
        await client.query(
          `INSERT INTO command_outbox(id,command_id,state) VALUES($1,$2,'PENDING')`,
          [randomUUID(), input.commandId],
        );
        await client.query(
          `INSERT INTO command_transitions(id,command_id,status,source)
           VALUES($1,$2,'QUEUED','HTTPS')`,
          [randomUUID(), input.commandId],
        );
      } else {
        const prior = await client.query("SELECT * FROM commands WHERE id=$1", [
          input.commandId,
        ]);
        row = prior.rows[0] as Record<string, unknown> | undefined;
      }
      if (!row) throw new Error("Command was not created or found");
      await client.query("COMMIT");
      return { command: commandFrom(row), created: Boolean(inserted.rows[0]) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(commandId: string) {
    const result = await this.pool.query("SELECT * FROM commands WHERE id=$1", [
      commandId,
    ]);
    return result.rows[0]
      ? commandFrom(result.rows[0] as Record<string, unknown>)
      : undefined;
  }

  async list(deviceId: string, limit: number) {
    const result = await this.pool.query(
      "SELECT * FROM commands WHERE device_id=$1 ORDER BY created_at DESC LIMIT $2",
      [deviceId, Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((row) =>
      commandFrom(row as Record<string, unknown>),
    );
  }

  async claim(now = new Date()): Promise<OutboxItem | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE command_outbox SET state='PENDING',locked_until=NULL
         WHERE state='IN_FLIGHT' AND locked_until <= $1`,
        [now],
      );
      const expired = await client.query(
        `UPDATE commands SET status='EXPIRED',reported_at=$1
         WHERE status='QUEUED' AND expires_at <= $1 RETURNING id`,
        [now],
      );
      for (const row of expired.rows as Array<{ id: string }>) {
        await client.query(
          "UPDATE command_outbox SET state='CANCELLED',locked_until=NULL WHERE command_id=$1",
          [row.id],
        );
        await client.query(
          `INSERT INTO command_transitions(id,command_id,status,source)
           VALUES($1,$2,'EXPIRED','WORKER')`,
          [randomUUID(), row.id],
        );
      }
      const selected = await client.query(
        `SELECT o.id AS outbox_id,o.attempts,c.*
         FROM command_outbox o JOIN commands c ON c.id=o.command_id
         WHERE o.state='PENDING' AND o.next_attempt_at <= $1
           AND c.status='QUEUED' AND c.expires_at > $1
         ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
        [now],
      );
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await client.query("COMMIT");
        return undefined;
      }
      const attempts = Number(row.attempts) + 1;
      await client.query(
        `UPDATE command_outbox SET state='IN_FLIGHT',attempts=$2,locked_until=$3,last_error=NULL
         WHERE id=$1`,
        [row.outbox_id, attempts, new Date(now.getTime() + 30_000)],
      );
      await client.query("COMMIT");
      return { id: String(row.outbox_id), command: commandFrom(row), attempts };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(outboxId: string, commandId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE command_outbox SET state='PUBLISHED',published_at=now(),locked_until=NULL
         WHERE id=$1 AND state='IN_FLIGHT'`,
        [outboxId],
      );
      await client.query(
        `INSERT INTO command_transitions(id,command_id,status,source)
         VALUES($1,$2,'PUBLISHED','MQTT')`,
        [randomUUID(), commandId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async retry(outboxId: string, reason: string, retryAt: Date) {
    await this.pool.query(
      `UPDATE command_outbox
       SET state='PENDING',next_attempt_at=$2,locked_until=NULL,last_error=$3
       WHERE id=$1 AND state='IN_FLIGHT'`,
      [outboxId, retryAt, reason],
    );
  }

  async applyResult(result: DeviceResult) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const commandResult = await client.query(
        "SELECT * FROM commands WHERE id=$1 FOR UPDATE",
        [result.commandId],
      );
      const row = commandResult.rows[0] as Record<string, unknown> | undefined;
      if (!row || String(row.device_id) !== result.deviceId) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (!canTransition(String(row.status) as CommandStatus, result.status)) {
        await client.query("COMMIT");
        return commandFrom(row);
      }
      const inserted = await client.query(
        `INSERT INTO command_results(
          message_id,command_id,device_id,status,reported_at,progress_percent,result,error)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         ON CONFLICT(message_id) DO NOTHING RETURNING message_id`,
        [
          result.messageId,
          result.commandId,
          result.deviceId,
          result.status,
          result.reportedAt,
          result.progressPercent ?? null,
          JSON.stringify(result.result ?? null),
          JSON.stringify(result.error ?? null),
        ],
      );
      if (inserted.rowCount) {
        await client.query(
          "UPDATE commands SET status=$2,reported_at=$3 WHERE id=$1",
          [result.commandId, result.status, result.reportedAt],
        );
        await client.query(
          `INSERT INTO command_transitions(id,command_id,status,source,details)
           VALUES($1,$2,$3,'DEVICE',$4::jsonb)`,
          [
            randomUUID(),
            result.commandId,
            result.status,
            JSON.stringify({ messageId: result.messageId }),
          ],
        );
      }
      await client.query("COMMIT");
      return await this.get(result.commandId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    await this.pool.query("SELECT 1");
  }

  async close() {
    await this.pool.end();
  }
}
