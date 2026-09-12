-- Ship Spotlight marketing profiles and independent Mailchimp email-asset mappings.
-- Canonical ship facts remain in ci_cruise_ships; this table stores only editorial/presentation choices.

create table if not exists public.ship_spotlights (
  id uuid primary key default gen_random_uuid(),
  ship_id uuid not null references public.ci_cruise_ships(id) on delete cascade,
  eyebrow text not null default 'SHIP OF THE WEEK',
  newsletter_heading text,
  editorial_intro text,
  highlights jsonb not null default '[]'::jsonb,
  stat_keys text[] not null default array['year_built','passenger_capacity','crew_count','gross_tonnage','length_metres','deck_count']::text[],
  hero_image_url text,
  supporting_image_urls text[] not null default '{}'::text[],
  public_slug text not null,
  publication_status text not null default 'draft',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint ship_spotlights_ship_unique unique (ship_id),
  constraint ship_spotlights_public_slug_unique unique (public_slug),
  constraint ship_spotlights_publication_status_chk check (publication_status in ('draft','published','archived')),
  constraint ship_spotlights_highlights_array_chk check (jsonb_typeof(highlights) = 'array')
);

create index if not exists ship_spotlights_public_lookup_idx
  on public.ship_spotlights (public_slug, publication_status, active);

alter table public.ship_spotlights enable row level security;

drop policy if exists "Admins can select ship spotlights" on public.ship_spotlights;
create policy "Admins can select ship spotlights"
  on public.ship_spotlights for select to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can insert ship spotlights" on public.ship_spotlights;
create policy "Admins can insert ship spotlights"
  on public.ship_spotlights for insert to authenticated
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can update ship spotlights" on public.ship_spotlights;
create policy "Admins can update ship spotlights"
  on public.ship_spotlights for update to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can delete ship spotlights" on public.ship_spotlights;
create policy "Admins can delete ship spotlights"
  on public.ship_spotlights for delete to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Public can read published ship spotlights" on public.ship_spotlights;
create policy "Public can read published ship spotlights"
  on public.ship_spotlights for select to anon, authenticated
  using (publication_status = 'published' and active = true);

create table if not exists public.ship_spotlight_email_assets (
  id uuid primary key default gen_random_uuid(),
  spotlight_id uuid not null references public.ship_spotlights(id) on delete cascade,
  asset_type text not null default 'hero',
  source_url text not null,
  source_url_normalized text not null,
  source_path text,
  source_checksum text not null,
  mailchimp_file_id text not null,
  mailchimp_file_url text not null,
  mailchimp_folder_id text,
  generated_filename text not null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint ship_spotlight_email_assets_unique unique (spotlight_id, source_checksum)
);

create index if not exists ship_spotlight_email_assets_spotlight_idx
  on public.ship_spotlight_email_assets (spotlight_id);

alter table public.ship_spotlight_email_assets enable row level security;

drop policy if exists "Admins can select ship spotlight email assets" on public.ship_spotlight_email_assets;
create policy "Admins can select ship spotlight email assets"
  on public.ship_spotlight_email_assets for select to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can insert ship spotlight email assets" on public.ship_spotlight_email_assets;
create policy "Admins can insert ship spotlight email assets"
  on public.ship_spotlight_email_assets for insert to authenticated
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can update ship spotlight email assets" on public.ship_spotlight_email_assets;
create policy "Admins can update ship spotlight email assets"
  on public.ship_spotlight_email_assets for update to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true))
  with check (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));

drop policy if exists "Admins can delete ship spotlight email assets" on public.ship_spotlight_email_assets;
create policy "Admins can delete ship spotlight email assets"
  on public.ship_spotlight_email_assets for delete to authenticated
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true));
