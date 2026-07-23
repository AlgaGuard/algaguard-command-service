import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://localhost/algaguard",
  MQTT_URL: "mqtts://broker:8884",
  MQTT_CA_PATH: "/run/pki/ca.crt",
  MQTT_CERTIFICATE_PATH: "/run/pki/command.crt",
  MQTT_PRIVATE_KEY_PATH: "/run/pki/command.key",
  MQTT_SERVER_NAME: "broker",
};

test("command MQTT transport requires TLS and bounded session settings", () => {
  const config = loadConfig(valid);
  assert.equal(config.MQTT_CLIENT_ID, "algaguard-command-service");
  assert.equal(config.MQTT_QOS1_INFLIGHT, 32);
  assert.equal(config.MQTT_SESSION_EXPIRY_SECONDS, 3600);
  assert.throws(() => loadConfig({ ...valid, MQTT_URL: "mqtt://broker:1883" }));
  assert.throws(() => loadConfig({ ...valid, MQTT_QOS1_INFLIGHT: "0" }));
});
