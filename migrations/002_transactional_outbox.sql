ALTER TABLE commands ALTER COLUMN device_id TYPE text USING device_id::text;
ALTER TABLE commands DROP CONSTRAINT IF EXISTS commands_deduplication_key_key;
ALTER TABLE commands
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS created_by text,
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS reported_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS commands_device_deduplication
  ON commands(device_id, deduplication_key);

CREATE TABLE IF NOT EXISTS command_outbox (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE REFERENCES commands(id),
  state text NOT NULL CHECK (state IN ('PENDING','IN_FLIGHT','PUBLISHED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS command_outbox_pending
  ON command_outbox(state,next_attempt_at);

CREATE TABLE IF NOT EXISTS command_transitions (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES commands(id),
  status text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS command_transitions_command_time
  ON command_transitions(command_id,occurred_at);

CREATE TABLE IF NOT EXISTS command_results (
  message_id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES commands(id),
  device_id text NOT NULL,
  status text NOT NULL,
  reported_at timestamptz NOT NULL,
  progress_percent integer,
  result jsonb,
  error jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
