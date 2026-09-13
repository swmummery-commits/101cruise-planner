create or replace function public.preserve_ci_ship_stateroom_extended_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  old_has_balcony boolean := false;
  new_has_balcony boolean := false;
  merged jsonb;
begin
  if old.stateroom_breakdown is null or new.stateroom_breakdown is null then
    return new;
  end if;

  if jsonb_typeof(old.stateroom_breakdown) <> 'array'
     or jsonb_typeof(new.stateroom_breakdown) <> 'array' then
    return new;
  end if;

  select exists (
    select 1
    from jsonb_array_elements(old.stateroom_breakdown) e
    where e ? 'balcony_sqm'
  ) into old_has_balcony;

  select exists (
    select 1
    from jsonb_array_elements(new.stateroom_breakdown) e
    where e ? 'balcony_sqm'
  ) into new_has_balcony;

  -- Older save paths rebuild stateroom rows using only label/count/sqm. If an
  -- update drops every balcony field at once, preserve the already-saved
  -- balcony values and source metadata by matching room labels.
  if old_has_balcony and not new_has_balcony then
    select coalesce(
      jsonb_agg(
        case
          when oldrow.elem is null then newrow.elem
          else newrow.elem
            || case
                 when oldrow.elem ? 'balcony_sqm'
                   then jsonb_build_object('balcony_sqm', oldrow.elem->'balcony_sqm')
                 else '{}'::jsonb
               end
            || case
                 when oldrow.elem ? 'balcony_sqm_source'
                   then jsonb_build_object('balcony_sqm_source', oldrow.elem->'balcony_sqm_source')
                 else '{}'::jsonb
               end
            || case
                 when oldrow.elem ? 'sqm_source'
                   then jsonb_build_object('sqm_source', oldrow.elem->'sqm_source')
                 else '{}'::jsonb
               end
        end
        order by newrow.ord
      ),
      '[]'::jsonb
    )
    into merged
    from jsonb_array_elements(new.stateroom_breakdown) with ordinality as newrow(elem, ord)
    left join lateral (
      select o.elem
      from jsonb_array_elements(old.stateroom_breakdown) as o(elem)
      where lower(regexp_replace(trim(coalesce(o.elem->>'label', '')), '\s+', ' ', 'g'))
          = lower(regexp_replace(trim(coalesce(newrow.elem->>'label', '')), '\s+', ' ', 'g'))
      limit 1
    ) as oldrow on true;

    new.stateroom_breakdown := merged;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_preserve_ci_ship_stateroom_extended_fields
  on public.ci_cruise_ships;

create trigger trg_preserve_ci_ship_stateroom_extended_fields
before update of stateroom_breakdown on public.ci_cruise_ships
for each row
execute function public.preserve_ci_ship_stateroom_extended_fields();
