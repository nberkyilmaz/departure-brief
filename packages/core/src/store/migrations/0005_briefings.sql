-- Briefings are immutable documents keyed by their content hash. A flight
-- key groups the briefings of one flight so that "what changed since my
-- last briefing?" is a query, not a reconstruction.

create table briefings (
  sha256     text primary key check (length(sha256) = 64),
  flight_key text not null,
  as_of      timestamptz not null,
  created_at timestamptz not null,
  document   jsonb not null
);

create index briefings_flight_as_of on briefings (flight_key, as_of desc);
