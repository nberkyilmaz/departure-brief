-- Rows loaded before `source` existed carry no `source` inside the JSON
-- document. Backfill from the column so every stored Airport is complete.

update airports
   set airport = airport || jsonb_build_object('source', source)
 where airport->>'source' is null;
