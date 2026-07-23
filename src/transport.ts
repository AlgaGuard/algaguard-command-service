import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mqtt, { type MqttClient } from "mqtt";
import { z } from "zod";
import type {
  Command,
  CommandPublisher,
  CommandRepository,
  DeviceResult,
} from "./domain.js";
import type { ServiceConfig } from "./config.js";

const errorDetail = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(256),
    retryable: z.boolean(),
    path: z.string().max(256).optional(),
  })
  .strict();
const resultEnvelope = z
  .object({
    schema: z.literal("urn:algaguard:schema:mqtt:command-result:v1"),
    schemaVersion: z.literal("1.0.0"),
    messageId: z.string().uuid(),
    deviceId: z.string().regex(/^AG-[0-9]{6}$/),
    sentAt: z.string().datetime(),
    correlationId: z.string().uuid().optional(),
    payload: z
      .object({
        commandId: z.string().uuid(),
        status: z.enum([
          "RECEIVED",
          "IN_PROGRESS",
          "SUCCEEDED",
          "FAILED",
          "REJECTED",
          "EXPIRED",
        ]),
        reportedAt: z.string().datetime(),
        progressPercent: z.number().int().min(0).max(100).optional(),
        result: z.record(z.string(), z.unknown()).optional(),
        error: errorDetail.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (["FAILED", "REJECTED"].includes(value.status) && !value.error)
          context.addIssue({
            code: "custom",
            message: "failed results require error detail",
          });
      }),
  })
  .strict();

export class MqttCommandTransport implements CommandPublisher {
  private constructor(
    private readonly client: MqttClient,
    private readonly repository: CommandRepository,
  ) {}

  static async connect(repository: CommandRepository, config: ServiceConfig) {
    const [ca, cert, key] = await Promise.all([
      readFile(config.MQTT_CA_PATH),
      readFile(config.MQTT_CERTIFICATE_PATH),
      readFile(config.MQTT_PRIVATE_KEY_PATH),
    ]);
    const client = await mqtt.connectAsync(config.MQTT_URL, {
      clientId: config.MQTT_CLIENT_ID,
      ca,
      cert,
      key,
      servername: config.MQTT_SERVER_NAME,
      rejectUnauthorized: true,
      protocolVersion: 5,
      clean: false,
      keepalive: config.MQTT_KEEPALIVE_SECONDS,
      reconnectPeriod: config.MQTT_RECONNECT_DELAY_MS,
      queueQoSZero: false,
      properties: {
        receiveMaximum: config.MQTT_QOS1_INFLIGHT,
        sessionExpiryInterval: config.MQTT_SESSION_EXPIRY_SECONDS,
      },
    });
    const transport = new MqttCommandTransport(client, repository);
    await client.subscribeAsync("algaguard/v1/devices/+/command-results", {
      qos: 1,
    });
    client.on(
      "message",
      (topic, bytes) => void transport.receive(topic, bytes),
    );
    return transport;
  }

  private async receive(topic: string, bytes: Buffer) {
    try {
      const topicDevice =
        /^algaguard\/v1\/devices\/(?<deviceId>AG-[0-9]{6})\/command-results$/.exec(
          topic,
        )?.groups?.deviceId;
      const envelope = resultEnvelope.parse(JSON.parse(bytes.toString()));
      // EMQX binds the authenticated device principal to this topic segment.
      if (!topicDevice || topicDevice !== envelope.deviceId)
        throw new Error("Command result topic and device identity mismatch");
      const result: DeviceResult = {
        messageId: envelope.messageId,
        deviceId: envelope.deviceId,
        commandId: envelope.payload.commandId,
        status: envelope.payload.status,
        reportedAt: envelope.payload.reportedAt,
        ...(envelope.payload.progressPercent === undefined
          ? {}
          : { progressPercent: envelope.payload.progressPercent }),
        ...(envelope.payload.result ? { result: envelope.payload.result } : {}),
        ...(envelope.payload.error
          ? {
              error: {
                code: envelope.payload.error.code,
                message: envelope.payload.error.message,
                retryable: envelope.payload.error.retryable,
                ...(envelope.payload.error.path
                  ? { path: envelope.payload.error.path }
                  : {}),
              },
            }
          : {}),
      };
      await this.repository.applyResult(result);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          component: "command-results",
          message:
            error instanceof Error ? error.message : "invalid command result",
        })}\n`,
      );
    }
  }

  async publish(command: Command) {
    if (Date.parse(command.expiresAt) <= Date.now())
      throw new Error("Command expired before MQTT publication");
    await this.client.publishAsync(
      `algaguard/v1/devices/${command.deviceId}/commands`,
      JSON.stringify({
        schema: "urn:algaguard:schema:mqtt:command:v1",
        schemaVersion: "1.0.0",
        messageId: randomUUID(),
        deviceId: command.deviceId,
        sentAt: new Date().toISOString(),
        correlationId: command.correlationId,
        payload: {
          commandId: command.commandId,
          commandType: command.commandType,
          createdAt: command.createdAt,
          expiresAt: command.expiresAt,
          issuedBy: `user:${command.createdBy}`,
          parameters: command.parameters,
          correlationId: command.correlationId,
        },
      }),
      { qos: 1, retain: false },
    );
  }

  async close() {
    await this.client.endAsync();
  }
}
