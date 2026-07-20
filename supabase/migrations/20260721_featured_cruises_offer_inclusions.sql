-- Move Offer Inclusions to the Featured Cruise parent record.
-- Pricing-row inclusion columns remain for compatibility but are unused by Admin.

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS alcohol_package boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS wifi boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS gratuities boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS all_tours boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS all_dining boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS laundry boolean NOT NULL DEFAULT false;

ALTER TABLE public.featured_cruises
  ADD COLUMN IF NOT EXISTS onboard_credit numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'featured_cruises_onboard_credit_check'
  ) THEN
    ALTER TABLE public.featured_cruises
      ADD CONSTRAINT featured_cruises_onboard_credit_check
      CHECK (onboard_credit IS NULL OR onboard_credit >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.featured_cruises.alcohol_package IS
  'Offer-level inclusion applying to the whole Featured Cruise.';
COMMENT ON COLUMN public.featured_cruises.onboard_credit IS
  'Offer-level On Board Credit amount in USD for the whole Featured Cruise.';
