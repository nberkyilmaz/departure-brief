-- Raw reports are content-addressed and append-only. Nothing in these tables
-- is ever updated or deleted; a newer decoder writes a new decoded row keyed
-- by its version, and every fetch is logged so that "what was known at time
-- T" can always be answered.

create table raw_reports (
  sha256        text primary key check (length(sha256) = 64),
  kind          text not null,
  source        text not null,
  station       text,
  body          text not null,
  issued_at     timestamptz,
  upstream      jsonb,
  first_seen_at timestamptz not null
);

create index raw_reports_station_kind_issued
  on raw_reports (station, kind, issued_at desc);

create table report_fetches (
  id         bigserial primary key,
  sha256     text not null references raw_reports (sha256),
  fetched_at timestamptz not null,
  request    text not null
);

create index report_fetches_sha256 on report_fetches (sha256);

create table decoded_reports (
  sha256          text not null references raw_reports (sha256),
  decoder_version integer not null,
  kind            text not null,
  decoded         jsonb not null,
  decoded_at      timestamptz not null,
  primary key (sha256, decoder_version)
);
