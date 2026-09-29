-- P3P: Princess Mac harvest request queue for NETLIFY_ORCHESTRATED_MAC_HARVEST.
-- No service-role secrets, cookies, or raw client IDs are stored.

create table if not exists public.princess_harvest_requests (
  id uuid primary key,
  period_key text not null,
  run_record_id uuid null,
  dispatch_id text not null,
  requested_at timestamptz not null default now(),
  claimed_at timestamptz null,
  worker_id text null,
  started_at timestamptz null,
  finished_at timestamptz null,
  last_heartbeat_at timestamptz null,
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'running', 'completed', 'failed', 'timed_out')),
  dry_run boolean not null default true,
  source_snapshot_hash text null,
  eligible_count integer null,
  error_code text null,
  error_detail_sanitized text null,
  source_freeze jsonb null
);

create unique index if not exists princess_harvest_requests_period_dispatch_uidx
  on public.princess_harvest_requests (period_key, dispatch_id);

create index if not exists princess_harvest_requests_queued_idx
  on public.princess_harvest_requests (status, requested_at)
  where status = 'queued';

create table if not exists public.princess_source_worker_heartbeats (
  worker_id text primary key,
  last_seen_at timestamptz not null default now(),
  hostname_class text null,
  status text not null default 'idle',
  pid integer null
);

create or replace function public.claim_princess_harvest_request(
  p_worker_id text,
  p_claimed_at timestamptz default now()
)
returns public.princess_harvest_requests
language plpgsql
as $$
declare
  rec public.princess_harvest_requests;
begin
  select *
    into rec
    from public.princess_harvest_requests
   where status = 'queued'
   order by requested_at asc
   for update skip locked
   limit 1;
  if not found then
    return null;
  end if;
  update public.princess_harvest_requests
     set status = 'claimed',
         claimed_at = p_claimed_at,
         worker_id = p_worker_id,
         last_heartbeat_at = p_claimed_at
   where id = rec.id
   returning * into rec;
  return rec;
end;
$$;

grant select, insert, update on public.princess_harvest_requests to service_role;
grant select, insert, update, delete on public.princess_source_worker_heartbeats to service_role;
grant execute on function public.claim_princess_harvest_request(text, timestamptz) to service_role;
