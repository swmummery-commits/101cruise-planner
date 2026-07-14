-- Data correction: included-in-fare cruise lines must not store drink prices as 0.
-- Zero previously implied "included"; NULL now means "not applicable / not listed".
-- Wi-Fi package prices, labels and notes are intentionally left unchanged.
--
-- Applies where drinks_included_in_fare = true (Silversea, Scenic, Seabourn, Azamara, Explora).

UPDATE public.cruise_line_calculator_rates
SET
  beer_price = NULL,
  wine_price = NULL,
  cocktail_price = NULL,
  spirits_mixer_price = NULL,
  premium_coffee_price = NULL,
  soft_drink_price = NULL,
  juice_price = NULL,
  bottled_water_price = NULL,
  gratuity_percent = NULL
WHERE drinks_included_in_fare = true;
