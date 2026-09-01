-- Shore Excursions Group live Ship ID sheet sync support.

alter table public.ci_cruise_ships
  add column if not exists seg_ship_id text,
  add column if not exists seg_ship_name text,
  add column if not exists seg_cruise_line text,
  add column if not exists seg_last_seen_at timestamptz,
  add column if not exists seg_sync_status text;

create unique index if not exists ci_cruise_ships_seg_ship_id_unique
  on public.ci_cruise_ships (seg_ship_id)
  where seg_ship_id is not null;

create table if not exists public.seg_ship_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  source_url text not null,
  source_row_count integer not null default 0,
  matched_count integer not null default 0,
  updated_count integer not null default 0,
  unmatched_count integer not null default 0,
  ambiguous_count integer not null default 0,
  conflict_count integer not null default 0,
  missing_existing_count integer not null default 0,
  status text not null default 'running',
  details jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.seg_ship_sync_runs enable row level security;

create or replace function public.apply_seg_ship_sync(
  p_mappings jsonb,
  p_source_ids jsonb,
  p_seen_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
  v_missing integer := 0;
begin
  if jsonb_typeof(coalesce(p_mappings, '[]'::jsonb)) <> 'array' then
    raise exception 'p_mappings must be a JSON array';
  end if;
  if jsonb_typeof(coalesce(p_source_ids, '[]'::jsonb)) <> 'array' then
    raise exception 'p_source_ids must be a JSON array';
  end if;

  with incoming as (
    select *
    from jsonb_to_recordset(coalesce(p_mappings, '[]'::jsonb)) as x(
      id uuid,
      seg_ship_id text,
      seg_ship_name text,
      seg_cruise_line text
    )
  )
  update public.ci_cruise_ships as c
  set seg_ship_id = i.seg_ship_id,
      seg_ship_name = i.seg_ship_name,
      seg_cruise_line = i.seg_cruise_line,
      seg_last_seen_at = p_seen_at,
      seg_sync_status = 'matched'
  from incoming i
  where c.id = i.id
    and i.seg_ship_id is not null
    and btrim(i.seg_ship_id) <> '';

  get diagnostics v_updated = row_count;

  if jsonb_array_length(coalesce(p_source_ids, '[]'::jsonb)) > 0 then
    update public.ci_cruise_ships as c
    set seg_sync_status = 'missing_from_source'
    where c.seg_ship_id is not null
      and not exists (
        select 1
        from jsonb_array_elements_text(p_source_ids) as source_id(value)
        where source_id.value = c.seg_ship_id
      );
    get diagnostics v_missing = row_count;
  end if;

  return jsonb_build_object(
    'updated_count', v_updated,
    'missing_existing_count', v_missing
  );
end;
$$;

revoke all on function public.apply_seg_ship_sync(jsonb, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_seg_ship_sync(jsonb, jsonb, timestamptz) to service_role;
