import { randomUUID } from "node:crypto";
export interface Command {
  id: string;
  deviceId: string;
  type: string;
  payload: Record<string, unknown>;
  status: "PENDING" | "PUBLISHED" | "SUCCEEDED" | "FAILED" | "EXPIRED";
  expiresAt: number;
  deduplicationKey: string;
}
export class CommandStore {
  private readonly commands = new Map<string, Command>();
  private readonly dedupe = new Map<string, string>();
  create(
    deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    expiresAt: number,
    deduplicationKey: string,
  ) {
    const existing = this.dedupe.get(deduplicationKey);
    if (existing) return this.commands.get(existing)!;
    const command: Command = {
      id: randomUUID(),
      deviceId,
      type,
      payload,
      status: "PENDING",
      expiresAt,
      deduplicationKey,
    };
    this.commands.set(command.id, command);
    this.dedupe.set(deduplicationKey, command.id);
    return command;
  }
  publish(id: string, now = Date.now()) {
    const command = this.commands.get(id);
    if (!command) return undefined;
    command.status = command.expiresAt <= now ? "EXPIRED" : "PUBLISHED";
    return command;
  }
  get(id: string) {
    return this.commands.get(id);
  }
  list() {
    return [...this.commands.values()];
  }
  applyResult(id: string, status: string) {
    const command = this.commands.get(id);
    if (!command) return undefined;
    command.status = status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
    return command;
  }
}
