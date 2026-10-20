-- Model assessments of NOTAMs, cached on (NOTAM content, flight context,
-- prompt version, model). Re-briefing an unchanged flight re-uses every
-- row; a new prompt version or model writes new rows beside the old.

create table notam_assessments (
  notam_sha256   text not null references raw_reports (sha256),
  context_hash   text not null,
  prompt_version integer not null,
  model          text not null,
  assessment     jsonb not null,
  citation       text not null,
  provider       text not null,
  usage_input    integer not null,
  usage_output   integer not null,
  created_at     timestamptz not null,
  primary key (notam_sha256, context_hash, prompt_version, model)
);
