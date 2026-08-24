-- Empty luggage bag weight counts toward each traveller's checked allowance.
-- Defaults to 4.5kg (typical empty suitcase) and can be overridden per traveller.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_packing_v2_profiles'
  ) THEN
    ALTER TABLE public.user_packing_v2_profiles
      ADD COLUMN IF NOT EXISTS empty_luggage_weight_kg numeric DEFAULT 4.5;

    COMMENT ON COLUMN public.user_packing_v2_profiles.empty_luggage_weight_kg IS
      'Weight of the empty checked luggage bag in kg. Defaults to 4.5 and counts toward checked allowance.';

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'user_packing_v2_profiles_empty_luggage_weight_kg_chk'
    ) THEN
      ALTER TABLE public.user_packing_v2_profiles
        ADD CONSTRAINT user_packing_v2_profiles_empty_luggage_weight_kg_chk
        CHECK (empty_luggage_weight_kg IS NULL OR empty_luggage_weight_kg >= 0);
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'customer_packing_profiles'
  ) THEN
    ALTER TABLE public.customer_packing_profiles
      ADD COLUMN IF NOT EXISTS empty_luggage_weight_kg numeric DEFAULT 4.5;

    COMMENT ON COLUMN public.customer_packing_profiles.empty_luggage_weight_kg IS
      'Weight of the empty checked luggage bag in kg. Defaults to 4.5 and counts toward checked allowance.';

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'customer_packing_profiles_empty_luggage_weight_kg_chk'
    ) THEN
      ALTER TABLE public.customer_packing_profiles
        ADD CONSTRAINT customer_packing_profiles_empty_luggage_weight_kg_chk
        CHECK (empty_luggage_weight_kg IS NULL OR empty_luggage_weight_kg >= 0);
    END IF;
  END IF;
END $$;
