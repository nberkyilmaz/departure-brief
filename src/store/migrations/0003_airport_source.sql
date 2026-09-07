-- Airports now come from more than one source (NASR for the US, OurAirports
-- for everywhere else). The key gains the source; lookups prefer NASR.

alter table nasr_airports rename to airports;
alter table airports add column source text not null default 'nasr';
alter table airports drop constraint nasr_airports_pkey;
alter table airports add primary key (source, cycle, site_no, site_type);
alter index nasr_airports_icao rename to airports_icao;
alter index nasr_airports_faa rename to airports_faa;
