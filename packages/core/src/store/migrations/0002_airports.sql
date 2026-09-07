-- NASR airports, one row per (cycle, site number, site type): a site number
-- can be both an airport and a heliport. A new cycle inserts new rows;
-- lookups take the latest cycle. Runways are embedded as JSON: they are only
-- ever read with their airport.

create table nasr_airports (
  cycle          date not null,
  site_no        text not null,
  site_type      text not null,
  faa_id         text not null,
  icao_id        text,
  name           text not null,
  lat            double precision not null,
  lon            double precision not null,
  elevation_ft   real,
  mag_var_deg    real,
  airport        jsonb not null,
  loaded_at      timestamptz not null,
  primary key (cycle, site_no, site_type)
);

create index nasr_airports_icao on nasr_airports (icao_id, cycle desc);
create index nasr_airports_faa on nasr_airports (faa_id, cycle desc);
