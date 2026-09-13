alter table public.ci_ship_class_facility_templates
  add column if not exists stateroom_sizes jsonb not null default '[]'::jsonb;

comment on column public.ci_ship_class_facility_templates.stateroom_sizes is
  'Class-level default room and balcony sizes by stateroom type. Ship rows may override these values.';

revoke all on public.ci_ship_class_facility_templates from anon;
revoke all on public.ci_ship_class_facility_templates from authenticated;
grant all on public.ci_ship_class_facility_templates to service_role;
