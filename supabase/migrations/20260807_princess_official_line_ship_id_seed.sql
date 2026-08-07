-- Princess Cruises: official_line_ship_id seed (17 active resdb ships).
-- Update ONLY official_line_ship_id on existing ci_cruise_ships rows by stable ship UUID.
-- MS Excellence Princess is intentionally excluded (no active resdb sailings).

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'AP'
WHERE id = 'd2342775-c77a-418a-a9af-7dd957bcfe13' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'AP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'CB'
WHERE id = '5a90db4a-6eea-4781-9050-52d5298f6422' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'CB');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'CO'
WHERE id = '7be5d59a-80e6-45d9-a8a0-34c41d3769bd' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'CO');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'DI'
WHERE id = '48cc67ad-49e1-4df9-834a-e8a024e304dd' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'DI');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'EP'
WHERE id = 'c77c1b3e-9979-42aa-9126-cba8595c967e' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'EP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'EX'
WHERE id = '354b0e60-707e-4a08-adbe-a0735727f6e2' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'EX');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'GP'
WHERE id = 'cd701d1f-0a87-4242-8599-9d7950be7db8' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'GP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'IP'
WHERE id = 'd6d9e3d2-4563-4010-a08b-b5160aed16e5' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'IP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'KP'
WHERE id = 'bbde7c14-3ce4-4413-9a1d-ce96f627a254' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'KP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'MJ'
WHERE id = '3cb2865a-f645-49d3-a2bc-29307dc1d9c6' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'MJ');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'RP'
WHERE id = 'e3924ab7-4c90-4eac-9b4a-72505d877580' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'RP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'RU'
WHERE id = '78aee069-3f35-4c13-a911-7a949bf8fefc' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'RU');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'SA'
WHERE id = '3aa83dbf-9839-4073-8001-8bebf6a7da01' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'SA');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'ST'
WHERE id = '53ad15de-49e0-4e13-a429-3fd6dc3ba3cc' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'ST');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'SU'
WHERE id = '2db8c4ea-d43d-4316-b0eb-2648356b0b34' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'SU');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'XP'
WHERE id = '4e08923e-5daa-4238-aec7-00278b00d249' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'XP');

UPDATE public.ci_cruise_ships SET official_line_ship_id = 'YP'
WHERE id = 'f5417a2c-d17b-4130-a270-313f9225ebb5' AND cruise_line_id = 'c19f40a7-c160-4035-a845-14dada550e1f'
  AND (official_line_ship_id IS NULL OR official_line_ship_id = 'YP');
