create table if not exists public.newsletter_route_map_jobs (
  cruise_id uuid primary key references public.featured_cruises(id) on delete cascade,
  newsletter_id uuid not null references public.newsletters(id) on delete cascade,
  fingerprint text not null,
  status text not null check (status in ('queued','generating','ready','needs_attention','failed')),
  queued_at timestamptz not null default now(),
  lease_until timestamptz,
  claim_token uuid,
  attempts integer not null default 0,
  message text
);

alter table public.newsletter_route_map_jobs enable row level security;
revoke all on public.newsletter_route_map_jobs from anon, authenticated;
grant select, insert, update, delete on public.newsletter_route_map_jobs to service_role;

create or replace function public.newsletter_route_map_fingerprint(target uuid)
returns text language sql stable set search_path = public as $$
  select md5(coalesce(jsonb_agg(
    jsonb_build_array(s.id,s.stop_type,s.display_order,s.is_overnight,s.port_id,
      s.entered_port_text,s.entered_country_text,p.latitude,p.longitude,p.canonical_name,p.city,p.country)
    order by s.display_order,s.id
  )::text,'[]'))
  from public.featured_cruise_itinerary_stops s
  left join public.ports p on p.id=s.port_id
  where s.featured_cruise_id=target
$$;

create or replace function public.enqueue_newsletter_route_maps(issue uuid, retry_cruise uuid default null)
returns void language sql set search_path = public as $$
  insert into public.newsletter_route_map_jobs as jobs
    (cruise_id,newsletter_id,fingerprint,status)
  select c.id,issue,public.newsletter_route_map_fingerprint(c.id),'queued'
  from public.featured_cruises c
  where c.newsletter_id=issue and (retry_cruise is null or c.id=retry_cruise)
    and coalesce(c.publication_status,'draft') <> 'archived'
    and c.route_map_media_id is null and nullif(trim(c.route_map_image_url),'') is null
    and (
      retry_cruise is not null
      or c.route_map_png_path is null or c.route_map_svg_path is null
      or c.route_map_status = 'needs_regeneration'
      or exists (select 1 from public.newsletter_route_map_jobs j where j.cruise_id=c.id)
    )
  order by c.display_order,c.id
  on conflict (cruise_id) do update
    set newsletter_id=excluded.newsletter_id,fingerprint=excluded.fingerprint,
        status=case when jobs.status='generating' then jobs.status else 'queued' end,
        attempts=case when jobs.status='generating' then jobs.attempts else 0 end,
        queued_at=now(),message=null
    where jobs.fingerprint <> excluded.fingerprint or jobs.newsletter_id <> excluded.newsletter_id
      or (retry_cruise is not null and jobs.status in ('failed','needs_attention','ready'))
      or (jobs.status='ready' and exists (
        select 1 from public.featured_cruises c where c.id=jobs.cruise_id
        and (c.route_map_png_path is null or c.route_map_svg_path is null or c.route_map_status='needs_regeneration')
      ))
$$;

create or replace function public.claim_newsletter_route_map()
returns setof public.newsletter_route_map_jobs language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(101, 42);
  update public.newsletter_route_map_jobs
    set status=case when attempts >= 2 then 'failed' else 'queued' end,
        message=case when attempts >= 2 then 'Map generation exceeded its worker time limit.' else null end,
        claim_token=null,lease_until=null
    where status='generating' and lease_until <= now();
  if exists (select 1 from public.newsletter_route_map_jobs where status='generating') then
    return;
  end if;
  return query
    update public.newsletter_route_map_jobs j set
      status='generating',claim_token=gen_random_uuid(),
      lease_until=now()+interval '16 minutes',attempts=j.attempts+1
    where j.cruise_id = (
      select q.cruise_id from public.newsletter_route_map_jobs q
      join public.featured_cruises c on c.id=q.cruise_id
      where q.status='queued'
      order by q.queued_at,c.display_order,q.cruise_id limit 1
      for update of q skip locked
    )
    returning j.*;
end
$$;

create or replace function public.finish_newsletter_route_map(
  target uuid, token uuid, started_fingerprint text, started_issue uuid,
  outcome text, outcome_message text
)
returns void language sql set search_path = public as $$
  update public.newsletter_route_map_jobs j set
    status=case when j.fingerprint <> started_fingerprint or j.newsletter_id <> started_issue
      then 'queued' else outcome end,
    message=case when j.fingerprint = started_fingerprint and j.newsletter_id = started_issue
      then outcome_message else null end,
    attempts=case when j.fingerprint <> started_fingerprint or j.newsletter_id <> started_issue
      then 0 else j.attempts end,
    claim_token=null,lease_until=null
  where j.cruise_id=target and j.claim_token=token and j.status='generating'
$$;

revoke execute on function public.newsletter_route_map_fingerprint(uuid),
  public.enqueue_newsletter_route_maps(uuid,uuid), public.claim_newsletter_route_map(),
  public.finish_newsletter_route_map(uuid,uuid,text,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.newsletter_route_map_fingerprint(uuid),
  public.enqueue_newsletter_route_maps(uuid,uuid), public.claim_newsletter_route_map(),
  public.finish_newsletter_route_map(uuid,uuid,text,uuid,text,text)
  to service_role;
