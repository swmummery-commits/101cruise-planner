-- Add a simple universal base category to canonical stateroom types.
-- Detailed stateroom type names remain unchanged and are categorised manually in Admin.

alter table public.stateroom_types
  add column if not exists base_room_category text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stateroom_types_base_room_category_check'
      and conrelid = 'public.stateroom_types'::regclass
  ) then
    alter table public.stateroom_types
      add constraint stateroom_types_base_room_category_check
      check (
        base_room_category is null
        or base_room_category in ('Inside', 'Oceanview', 'Balcony', 'Suite')
      );
  end if;
end $$;
