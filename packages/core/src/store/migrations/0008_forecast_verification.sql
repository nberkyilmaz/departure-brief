-- Forecast verification: what a TAF promised for a moment, and what
-- arrived. Both halves are written once and never updated, like every
-- other record here, so a re-run can only add.

create table if not exists forecast_checks (
  key                 text primary key,
  station             text not null,
  valid_at            timestamptz not null,
  taf_sha256          text not null references raw_reports (sha256),
  taf_issued_at       timestamptz,
  taf_decoder_version integer not null,
  lead_hours          double precision,
  ceiling_ft          integer,
  visibility_sm       double precision,
  visibility_at_least boolean not null default false,
  wind_dir_true       integer,
  wind_kt             double precision,
  gust_kt             double precision,
  category            text,
  overlay_worst_category text,
  created_at          timestamptz not null
);

-- The question asked of this table is always "what is still unmatched, for
-- a station, whose moment has passed".
create index if not exists forecast_checks_station_valid on forecast_checks (station, valid_at desc);

create table if not exists forecast_outcomes (
  check_key      text not null references forecast_checks (key),
  metar_sha256   text not null references raw_reports (sha256),
  observed_at    timestamptz not null,
  offset_minutes integer not null,
  ceiling_ft     integer,
  visibility_sm  double precision,
  visibility_at_least boolean not null default false,
  wind_dir_true  integer,
  wind_kt        double precision,
  gust_kt        double precision,
  category       text,
  matched_at     timestamptz not null,
  primary key (check_key, metar_sha256)
);
