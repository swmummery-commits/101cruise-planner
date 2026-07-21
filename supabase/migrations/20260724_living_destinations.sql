-- Sprint 11C: Living Destination Pages
-- Lightweight destination + featured port shells. Editorial lives in research_content.
-- Imagery via media_library IDs only (no duplicated image URLs).
-- Additive / safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc', now());
  RETURN NEW;
END;
$$;

-- =========================================================
-- destinations (page shell — not research content)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  hero_media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL,
  research_content_id uuid NULL REFERENCES public.research_content(id) ON DELETE SET NULL,
  primary_region text NULL,
  display_order integer NOT NULL DEFAULT 100,
  seo_title text NULL,
  meta_description text NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT destinations_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT destinations_slug_not_blank CHECK (length(trim(slug)) > 0),
  CONSTRAINT destinations_status_check CHECK (status IN ('draft', 'published', 'hidden'))
);

CREATE UNIQUE INDEX IF NOT EXISTS destinations_slug_uidx
  ON public.destinations (lower(slug));

CREATE INDEX IF NOT EXISTS destinations_status_order_idx
  ON public.destinations (status, display_order, name);

CREATE INDEX IF NOT EXISTS destinations_research_idx
  ON public.destinations (research_content_id)
  WHERE research_content_id IS NOT NULL;

DROP TRIGGER IF EXISTS destinations_set_updated_at ON public.destinations;
CREATE TRIGGER destinations_set_updated_at
  BEFORE UPDATE ON public.destinations
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

-- =========================================================
-- destination_ports (featured ports for a destination page)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.destination_ports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id uuid NOT NULL REFERENCES public.destinations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  short_description text NULL,
  hero_media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL,
  research_content_id uuid NULL REFERENCES public.research_content(id) ON DELETE SET NULL,
  display_order integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT destination_ports_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT destination_ports_slug_not_blank CHECK (length(trim(slug)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS destination_ports_dest_slug_uidx
  ON public.destination_ports (destination_id, lower(slug));

CREATE INDEX IF NOT EXISTS destination_ports_dest_order_idx
  ON public.destination_ports (destination_id, active, display_order);

DROP TRIGGER IF EXISTS destination_ports_set_updated_at ON public.destination_ports;
CREATE TRIGGER destination_ports_set_updated_at
  BEFORE UPDATE ON public.destination_ports
  FOR EACH ROW
  EXECUTE PROCEDURE public.set_updated_at_timestamp();

-- =========================================================
-- RLS — admin manage; public reads via Netlify service role
-- =========================================================

ALTER TABLE public.destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.destination_ports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage destinations" ON public.destinations;
CREATE POLICY "Admins manage destinations"
  ON public.destinations
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );

DROP POLICY IF EXISTS "Admins manage destination ports" ON public.destination_ports;
CREATE POLICY "Admins manage destination ports"
  ON public.destination_ports
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.auth_user_id = auth.uid() AND au.active = true
    )
  );

-- =========================================================
-- Seed Alaska: published research + destination shell + ports
-- =========================================================

DO $$
DECLARE
  v_research_id uuid;
  v_destination_id uuid;
  v_content jsonb := '{
    "schema_version": "1.1",
    "entity_type": "destination",
    "overview": "Glaciers, wildlife and cool-climate scenic cruising through the Inside Passage — a classic bucket-list voyage for Australian travellers.",
    "why_visit": "Alaska is for travellers who want scenery that stops conversation. Glaciers, wildlife and cool summer light turn every sea day into the main event — not filler between ports. Classic stops like Juneau, Skagway and Ketchikan add gold-rush colour and easy shore days, while long daylight from May through August makes the season feel generous and alive. From Australia it is a longer journey, but a completely different kind of cruise: crisp air, dramatic horizons, and a genuine sense of wilderness you feel from the deck the moment you arrive.",
    "best_time_to_visit": "May – August",
    "climate_summary": "Cool & changeable",
    "cruise_length": "7 – 14 nights",
    "departure_ports": "Vancouver · Seattle · Seward",
    "ideal_for": ["Couples", "Scenic travellers", "Wildlife lovers"],
    "key_highlights": ["Inside Passage scenery", "Glacier viewing", "Wildlife", "Gold-rush ports"],
    "signature_experiences": ["Glacier Bay", "Whale watching", "White Pass railway"],
    "food_and_drink": "Fresh seafood is the highlight ashore — salmon, crab and local craft beer in the main ports.",
    "culture_and_etiquette": "A mix of Indigenous heritage and gold-rush history. English is spoken throughout.",
    "currency": "US Dollar (USD)",
    "languages": "English",
    "transport_summary": "Most guests arrive via Vancouver or Seattle and cruise the Inside Passage.",
    "accessibility_summary": "Shipboard access is generally good; shore excursions vary by port and weather.",
    "family_summary": "Strong for families who enjoy nature and wildlife over beach resorts.",
    "packing_summary": "Layers, waterproof jacket, comfortable walking shoes, binoculars.",
    "voltage": "120V",
    "tipping_ashore": "15–20% ashore",
    "walking_level": "Moderate",
    "suitability_couples": "excellent",
    "suitability_families": "very_good",
    "suitability_luxury": "very_good",
    "suitability_adventure": "excellent",
    "suitability_food_wine": "good",
    "suitability_first_cruise": "very_good",
    "suitability_summary": "Ideal if you want scenery and wildlife over beach days — especially couples and travellers happy to pack layers.",
    "cruise_lines_visiting": [
      "Holland America Line",
      "Princess Cruises",
      "Celebrity Cruises",
      "Norwegian Cruise Line",
      "Royal Caribbean",
      "Carnival Cruise Line"
    ],
    "good_to_know": [
      {"label": "Currency", "value": "USD"},
      {"label": "Voltage", "value": "120V"},
      {"label": "Language", "value": "English"},
      {"label": "Tipping", "value": "15–20% ashore"},
      {"label": "Climate", "value": "Cool summer"},
      {"label": "Walking Level", "value": "Moderate"}
    ],
    "frequently_asked_questions": [
      {
        "question": "When is the best time to cruise Alaska?",
        "answer": "Most sailings run from May to August. June and July usually offer the longest daylight and strongest wildlife viewing, while May and September can feel quieter with more changeable weather."
      },
      {
        "question": "Is Alaska a good first cruise?",
        "answer": "Yes — especially if you prefer scenery over nightlife. Choose a well-reviewed ship with a classic Inside Passage itinerary, pack layers, and keep shore days flexible for weather."
      },
      {
        "question": "Do I need a visa or ESTA from Australia?",
        "answer": "Most Australia and New Zealand travellers need an ESTA for the United States when itineraries include US ports or fly/cruise combinations. Always confirm your own documents before booking."
      },
      {
        "question": "Can Paul find a better price than the brochure fare?",
        "answer": "Often, yes. Brochure fares are a starting point. Share your dates, cabin preference and travel party and Paul can check current offers, amenity packages and the best available rate."
      }
    ],
    "research_notes": "Sprint 11C seed content migrated from the Alaska destination template."
  }'::jsonb;
BEGIN
  -- Published destination research (idempotent by entity_key)
  SELECT id INTO v_research_id
  FROM public.research_content
  WHERE entity_type = 'destination'
    AND entity_key = 'alaska'
    AND content_status = 'published'
  LIMIT 1;

  IF v_research_id IS NULL THEN
    INSERT INTO public.research_content (
      entity_type,
      entity_key,
      entity_name,
      content_status,
      content_version,
      schema_version,
      content_json,
      summary_text,
      seo_title,
      meta_description,
      canonical_slug,
      published_at,
      refresh_after,
      research_provider,
      generation_provider
    ) VALUES (
      'destination',
      'alaska',
      'Alaska',
      'published',
      1,
      '1.1',
      v_content,
      'Glaciers, wildlife and cool-climate scenic cruising through the Inside Passage — a classic bucket-list voyage for Australian travellers.',
      'Alaska Cruises | 101cruise',
      'Explore Alaska cruises with 101cruise — glaciers, wildlife and Inside Passage itineraries for Australian travellers.',
      'alaska',
      timezone('utc', now()),
      timezone('utc', now()) + interval '18 months',
      'seed',
      'seed'
    )
    RETURNING id INTO v_research_id;
  END IF;

  -- Destination shell
  SELECT id INTO v_destination_id
  FROM public.destinations
  WHERE lower(slug) = 'alaska'
  LIMIT 1;

  IF v_destination_id IS NULL THEN
    INSERT INTO public.destinations (
      name,
      slug,
      status,
      research_content_id,
      primary_region,
      display_order,
      seo_title,
      meta_description
    ) VALUES (
      'Alaska',
      'alaska',
      'published',
      v_research_id,
      'North America',
      10,
      'Alaska Cruises | 101cruise',
      'Explore Alaska cruises with 101cruise — glaciers, wildlife and Inside Passage itineraries for Australian travellers.'
    )
    RETURNING id INTO v_destination_id;
  ELSE
    UPDATE public.destinations
    SET
      status = 'published',
      research_content_id = COALESCE(research_content_id, v_research_id),
      primary_region = COALESCE(primary_region, 'North America'),
      seo_title = COALESCE(seo_title, 'Alaska Cruises | 101cruise'),
      meta_description = COALESCE(
        meta_description,
        'Explore Alaska cruises with 101cruise — glaciers, wildlife and Inside Passage itineraries for Australian travellers.'
      )
    WHERE id = v_destination_id;
  END IF;

  -- Featured ports (no hard-coded image URLs — Media Library IDs only)
  INSERT INTO public.destination_ports (
    destination_id, name, slug, short_description, display_order, active
  )
  SELECT v_destination_id, p.name, p.slug, p.short_description, p.display_order, true
  FROM (
    VALUES
      ('Juneau', 'juneau', 'Alaska’s capital — glaciers nearby, whale watching and a walkable waterfront.', 10),
      ('Skagway', 'skagway', 'Gold-rush town with the White Pass railway and a charming main street.', 20),
      ('Ketchikan', 'ketchikan', 'Totem poles, creek walks and rainforest scenery at the start of many itineraries.', 30),
      ('Sitka', 'sitka', 'Russian and Tlingit heritage with quieter harbour energy and coastal trails.', 40),
      ('Icy Strait Point', 'icy-strait-point', 'Wildlife, zip lines and a soft adventure stop near Hoonah.', 50)
  ) AS p(name, slug, short_description, display_order)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.destination_ports dp
    WHERE dp.destination_id = v_destination_id
      AND lower(dp.slug) = lower(p.slug)
  );
END $$;

COMMENT ON TABLE public.destinations IS
  'Sprint 11C Living Destination page shells. Editorial content comes from research_content; imagery from media_library.';
COMMENT ON TABLE public.destination_ports IS
  'Featured ports shown on a destination page. Hero images via media_library only.';
