import { randomUUID } from "node:crypto";

export type CommandType =
  | "REQUEST_STATUS"
  | "SET_INDICATOR_STATE"
  | "APPLY_PROFILE_CONFIGURATION"
  | "SYNC_TIME"
  | "REBOOT"
  | "PREPARE_OTA"
  | "REQUEST_PHYSICAL_UNPAIR";
export type CommandStatus =
  | "QUEUED"
  | "RECEIVED"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "REJECTED"
  | "EXPIRED";

export function canTransition(
  current: CommandStatus,
  next: Exclude<CommandStatus, "QUEUED">,
) {
  const transitions: Record<
    CommandStatus,
    Array<Exclude<CommandStatus, "QUEUED">>
  > = {
    QUEUED: [
      "RECEIVED",
      "IN_PROGRESS",
      "SUCCEEDED",
      "FAILED",
      "REJECTED",
      "EXPIRED",
    ],
    RECEIVED: [
      "RECEIVED",
      "IN_PROGRESS",
      "SUCCEEDED",
      "FAILED",
      "REJECTED",
      "EXPIRED",
    ],
    IN_PROGRESS: ["IN_PROGRESS", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"],
    SUCCEEDED: ["SUCCEEDED"],
    FAILED: ["FAILED"],
    REJECTED: ["REJECTED"],
    EXPIRED: ["EXPIRED"],
  };
  return transitions[current].includes(next);
}

export interface Command {
  commandId: string;
  deviceId: string;
  organizationId: string;
  commandType: CommandType;
  parameters: Record<string, unknown>;
  status: CommandStatus;
  createdAt: string;
  expiresAt: string;
  createdBy: string;
  correlationId: string;
  reportedAt: string | null;
}

export interface OutboxItem {
  id: string;
  command: Command;
  attempts: number;
}

export interface DeviceResult {
  messageId: string;
  deviceId: string;
  commandId: string;
  status: Exclude<CommandStatus, "QUEUED">;
  reportedAt: string;
  progressPercent?: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; path?: string };
}

export interface CommandRepository {
  create(input: Omit<Command, "status" | "createdAt" | "reportedAt">): Promise<{
    command: Command;
    created: boolean;
  }>;
  get(commandId: string): Promise<Command | undefined>;
  list(deviceId: string, limit: number): Promise<Command[]>;
  claim(now?: Date): Promise<OutboxItem | undefined>;
  markPublished(outboxId: string, commandId: string): Promise<void>;
  retry(outboxId: string, reason: string, retryAt: Date): Promise<void>;
  applyResult(result: DeviceResult): Promise<Command | undefined>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export interface CommandPublisher {
  publish(command: Command): Promise<void>;
}

export class CommandWorker {
  constructor(
    private readonly repository: CommandRepository,
    private readonly publisher: CommandPublisher,
  ) {}

  async runOnce(now = new Date()) {
    const item = await this.repository.claim(now);
    if (!item) return false;
    try {
      await this.publisher.publish(item.command);
      await this.repository.markPublished(item.id, item.command.commandId);
      return true;
    } catch (error) {
      const delay = Math.min(30_000, 250 * 2 ** Math.min(item.attempts, 7));
      await this.repository.retry(
        item.id,
        error instanceof Error ? error.message.slice(0, 256) : "publish failed",
        new Date(now.getTime() + delay),
      );
      return false;
    }
  }
}

export class MemoryCommandRepository implements CommandRepository {
  private readonly commands = new Map<string, Command>();
  private readonly outbox = new Map<
    string,
    {
      id: string;
      commandId: string;
      state: "PENDING" | "IN_FLIGHT" | "PUBLISHED";
      attempts: number;
      retryAt: Date;
    }
  >();
  private readonly resultIds = new Set<string>();

  async create(input: Omit<Command, "status" | "createdAt" | "reportedAt">) {
    const prior = this.commands.get(input.commandId);
    if (prior) return { command: structuredClone(prior), created: false };
    const command: Command = {
      ...structuredClone(input),
      status: "QUEUED",
      createdAt: new Date().toISOString(),
      reportedAt: null,
    };
    this.commands.set(command.commandId, command);
    const id = randomUUID();
    this.outbox.set(id, {
      id,
      commandId: command.commandId,
      state: "PENDING",
      attempts: 0,
      retryAt: new Date(0),
    });
    return { command: structuredClone(command), created: true };
  }

  async get(commandId: string) {
    return structuredClone(this.commands.get(commandId));
  }

  async list(deviceId: string, limit: number) {
    return [...this.commands.values()]
      .filter((command) => command.deviceId === deviceId)
      .slice(0, limit)
      .map((command) => structuredClone(command));
  }

  async claim(now = new Date()) {
    for (const command of this.commands.values()) {
      if (
        command.status === "QUEUED" &&
        Date.parse(command.expiresAt) <= now.getTime()
      ) {
        command.status = "EXPIRED";
      }
    }
    const row = [...this.outbox.values()].find(
      (value) =>
        value.state === "PENDING" &&
        value.retryAt <= now &&
        this.commands.get(value.commandId)?.status === "QUEUED",
    );
    if (!row) return undefined;
    row.state = "IN_FLIGHT";
    row.attempts += 1;
    return {
      id: row.id,
      command: structuredClone(this.commands.get(row.commandId)!),
      attempts: row.attempts,
    };
  }

  async markPublished(outboxId: string) {
    const row = this.outbox.get(outboxId);
    if (row) row.state = "PUBLISHED";
  }

  async retry(outboxId: string, _reason: string, retryAt: Date) {
    const row = this.outbox.get(outboxId);
    if (row) {
      row.state = "PENDING";
      row.retryAt = retryAt;
    }
  }

  async applyResult(result: DeviceResult) {
    const command = this.commands.get(result.commandId);
    if (!command || command.deviceId !== result.deviceId) return undefined;
    if (this.resultIds.has(result.messageId)) return structuredClone(command);
    if (!canTransition(command.status, result.status))
      return structuredClone(command);
    this.resultIds.add(result.messageId);
    command.status = result.status;
    command.reportedAt = result.reportedAt;
    return structuredClone(command);
  }

  async health() {}
  async close() {}
}
