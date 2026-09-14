-- When we last asked, as opposed to when we last received something.
--
-- `report_fetches` hangs off a report, so a request that came back empty
-- leaves no trace — and an empty answer is the normal answer for a hazard
-- advisory or for an aerodrome that publishes no upper winds. Without this,
-- "have we asked recently" is false every time and every briefing asks
-- again, which is exactly the discourtesy the freshness windows exist to
-- prevent.
--
-- `scope` is usually a station identifier, but not always: products that
-- belong to an area rather than a place are recorded under a name for the
-- area they cover.
create table if not exists fetch_attempts (
  scope         text not null,
  kind          text not null,
  attempted_at  timestamptz not null,
  request       text not null,
  primary key (scope, kind, attempted_at)
);

create index if not exists fetch_attempts_scope_kind
  on fetch_attempts (scope, kind, attempted_at desc);
