CREATE TABLE app.sandbox_sessions (
  id uuid PRIMARY KEY,
  ip_hash text NOT NULL,
  day text NOT NULL,
  last_turn integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX sandbox_sessions_ip_day_idx ON app.sandbox_sessions (ip_hash, day);

CREATE TABLE app.sandbox_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES app.sandbox_sessions (id),
  turn_index integer NOT NULL,
  input_hash text NOT NULL,
  skeleton_hash text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (session_id, turn_index)
);
CREATE INDEX sandbox_turns_session_idx ON app.sandbox_turns (session_id);

CREATE TABLE app.analysis_cache (
  cache_key text PRIMARY KEY,
  ops jsonb NOT NULL,
  source_turn integer NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE app.daily_counters (
  day text PRIMARY KEY,
  model_calls integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.graph_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  turn_index integer NOT NULL,
  event_ts timestamptz NOT NULL,
  ops jsonb NOT NULL,
  UNIQUE (session_id, turn_index)
);
CREATE INDEX graph_events_session_idx ON app.graph_events (session_id);

CREATE TABLE app.graph_maps (
  session_id uuid PRIMARY KEY,
  map jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE app.graph_failures (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  turn_index integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX graph_failures_session_idx ON app.graph_failures (session_id);

CREATE TABLE app.graph_meta (
  session_id uuid PRIMARY KEY,
  title text NOT NULL,
  created_at timestamptz NOT NULL
);