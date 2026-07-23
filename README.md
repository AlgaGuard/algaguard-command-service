# AlgaGuard command service

Authenticated users create contract-valid, expiring device commands only after an Access Service decision. PostgreSQL atomically stores the command, authorization context, initial transition, and transactional outbox intent. A lease-based worker publishes non-retained QoS 1 MQTT messages, retries transient failures with bounded backoff, recovers abandoned leases, and never publishes expired commands.

Device command-result envelopes are validated and bound to the EMQX-authenticated topic device. Result `messageId` values are unique, so repeated delivery is idempotent. Commands, outbox state, device results, and transition history remain authoritative across service restarts. In-memory storage is an explicitly injected test adapter only.

```sh
npm ci
npm run migrate
npm run check
docker build -t algaguard-command-service:local .
```

No MQTT credential is committed, and subject or role headers are never trusted. This evidence uses a simulated publisher and local PostgreSQL; it does not claim production deployment, physical-device delivery, MicroSD validation, or battery validation.
