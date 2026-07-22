CREATE TABLE commands (id uuid PRIMARY KEY, device_id uuid NOT NULL, type text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, expires_at timestamptz NOT NULL, deduplication_key text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());

