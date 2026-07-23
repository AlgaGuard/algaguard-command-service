import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  MQTT_URL: z.string().url().startsWith("mqtts://"),
  MQTT_CLIENT_ID: z
    .literal("algaguard-command-service")
    .default("algaguard-command-service"),
  MQTT_CA_PATH: z.string().min(1),
  MQTT_CERTIFICATE_PATH: z.string().min(1),
  MQTT_PRIVATE_KEY_PATH: z.string().min(1),
  MQTT_SERVER_NAME: z.string().min(1).max(253),
  MQTT_QOS1_INFLIGHT: z.coerce.number().int().min(1).max(1024).default(32),
  MQTT_KEEPALIVE_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  MQTT_SESSION_EXPIRY_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(604800)
    .default(3600),
  MQTT_RECONNECT_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60000)
    .default(2000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});
export type ServiceConfig = z.infer<typeof environmentSchema>;
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  return environmentSchema.parse(environment);
}
