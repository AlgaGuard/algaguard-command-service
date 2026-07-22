import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import type { Command, CommandStore } from "./domain.js";

let client: MqttClient | undefined;

export async function startCommandTransport(store: CommandStore) {
  const url = process.env.MQTT_URL;
  if (!url) return undefined;
  const options = {
    clientId: `algaguard-command-${randomUUID()}`,
    username: "development-command",
    clean: true,
    reconnectPeriod: 2_000,
  };
  client = await mqtt.connectAsync(url, options);
  await client.subscribeAsync("algaguard/v1/devices/#", { qos: 1 });
  client.on("message", (topic, bytes) => {
    if (!topic.endsWith("/command-results")) return;
    try {
      const value = JSON.parse(bytes.toString()) as {
        payload?: { commandId?: string; status?: string };
      };
      if (value.payload?.commandId && value.payload.status) {
        store.applyResult(value.payload.commandId, value.payload.status);
      }
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", component: "command-results", message: error instanceof Error ? error.message : "unknown error" })}\n`,
      );
    }
  });
  return client;
}

export async function publishCommand(command: Command) {
  if (!client?.connected)
    throw new Error("MQTT command transport is not connected");
  await client.publishAsync(
    `algaguard/v1/devices/${command.deviceId}/commands`,
    JSON.stringify({
      schema: "urn:algaguard:schema:mqtt:command:v1",
      schemaVersion: "1.0.0",
      messageId: randomUUID(),
      deviceId: command.deviceId,
      sentAt: new Date().toISOString(),
      correlationId: randomUUID(),
      payload: {
        commandId: command.id,
        commandType: command.type,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(command.expiresAt).toISOString(),
        issuedBy: "service:algaguard-command-service",
        parameters: command.payload,
        correlationId: randomUUID(),
      },
    }),
    { qos: 1, retain: false },
  );
}
