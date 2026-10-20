-- A fetch can be *for* a station without the report being about one (a
-- FIR-wide NOTAM returned for CYKF). Recording that on the fetch keeps the
-- association append-only and lets a per-station listing include it.

alter table report_fetches add column station text;
create index report_fetches_station on report_fetches (station, sha256);
