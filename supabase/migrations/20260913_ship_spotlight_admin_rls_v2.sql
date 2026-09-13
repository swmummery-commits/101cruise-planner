drop policy if exists "Admins can select ship spotlights" on public.ship_spotlights;
drop policy if exists "Admins can insert ship spotlights" on public.ship_spotlights;
drop policy if exists "Admins can update ship spotlights" on public.ship_spotlights;
drop policy if exists "Admins can delete ship spotlights" on public.ship_spotlights;

create policy "Admins can select ship spotlights"
on public.ship_spotlights for select to authenticated
using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  or exists (
    select 1 from public.admin_users a
    where a.active = true
      and (a.auth_user_id = auth.uid() or lower(a.email) = lower(coalesce(auth.jwt()->>'email','')))
  )
);

create policy "Admins can insert ship spotlights"
on public.ship_spotlights for insert to authenticated
with check (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  or exists (
    select 1 from public.admin_users a
    where a.active = true
      and (a.auth_user_id = auth.uid() or lower(a.email) = lower(coalesce(auth.jwt()->>'email','')))
  )
);

create policy "Admins can update ship spotlights"
on public.ship_spotlights for update to authenticated
using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  or exists (
    select 1 from public.admin_users a
    where a.active = true
      and (a.auth_user_id = auth.uid() or lower(a.email) = lower(coalesce(auth.jwt()->>'email','')))
  )
)
with check (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  or exists (
    select 1 from public.admin_users a
    where a.active = true
      and (a.auth_user_id = auth.uid() or lower(a.email) = lower(coalesce(auth.jwt()->>'email','')))
  )
);

create policy "Admins can delete ship spotlights"
on public.ship_spotlights for delete to authenticated
using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  or exists (
    select 1 from public.admin_users a
    where a.active = true
      and (a.auth_user_id = auth.uid() or lower(a.email) = lower(coalesce(auth.jwt()->>'email','')))
  )
);
