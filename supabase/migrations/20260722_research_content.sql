-- Sprint 10D: AI Research Content Engine
-- Additive only. Safe to re-run. Does not alter CI ships/lines, featured cruises, or media library.

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
-- research_content
-- =========================================================

CREATE TABLE IF NOT EXISTS public.research_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NULL,
  entity_key text NULL,
  entity_name text NOT NULL,
  content_status text NOT NULL DEFAULT 'draft',
  content_version integer NOT NULL DEFAULT 1,
  schema_version text NOT NULL DEFAULT '1.0',
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_text text NULL,
  seo_title text NULL,
  meta_description text NULL,
  canonical_slug text NULL,
  pauls_tip text NULL,
  media_id uuid NULL REFERENCES public.media_library(id) ON DELETE SET NULL,
  source_count integer NOT NULL DEFAULT 0,
  research_provider text NULL,
  generation_provider text NULL,
  generation_model text NULL,
  generated_at timestamptz NULL,
  last_reviewed_at timestamptz NULL,
  published_at timestamptz NULL,
  refresh_after timestamptz NULL,
  diagnostics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_detail text NULL,
  replaces_id uuid NULL REFERENCES public.research_content(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT research_content_entity_type_check
    CHECK (entity_type IN ('ship', 'destination', 'port', 'cruise_line')),
  CONSTRAINT research_content_status_check
    CHECK (content_status IN ('draft', 'reviewed', 'published', 'archived', 'failed')),
  CONSTRAINT research_content_name_not_blank
    CHECK (length(trim(entity_name)) > 0),
  CONSTRAINT research_content_version_positive
    CHECK (content_version >= 1),
  CONSTRAINT research_content_entity_ref_check
    CHECK (entity_id IS NOT NULL OR (entity_key IS NOT NULL AND length(trim(entity_key)) > 0))
);

CREATE INDEX IF NOT EXISTS research_content_entity_type_status_idx
  ON public.research_content (entity_type, content_status);

CREATE INDEX IF NOT EXISTS research_content_entity_id_idx
  ON public.research_content (entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS research_content_entity_key_idx
  ON public.research_content (entity_type, entity_key)
  WHERE entity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS research_content_refresh_after_idx
  ON public.research_content (refresh_after)
  WHERE content_status = 'published';

CREATE INDEX IF NOT EXISTS research_content_canonical_slug_idx
  ON public.research_content (canonical_slug)
  WHERE canonical_slug IS NOT NULL;

-- One current published record per canonical entity_id
CREATE UNIQUE INDEX IF NOT EXISTS research_content_one_published_entity_id_uidx
  ON public.research_content (entity_type, entity_id)
  WHERE content_status = 'published' AND entity_id IS NOT NULL;

-- One current published record per entity_key (destinations/ports)
CREATE UNIQUE INDEX IF NOT EXISTS research_content_one_published_entity_key_uidx
  ON public.research_content (entity_type, entity_key)
  WHERE content_status = 'published' AND entity_key IS NOT NULL AND entity_id IS NULL;

DROP TRIGGER IF EXISTS research_content_set_updated_at ON public.research_content;
CREATE TRIGGER research_content_set_updated_at
  BEFORE UPDATE ON public.research_content
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at_timestamp();

-- =========================================================
-- research_content_sources
-- =========================================================

CREATE TABLE IF NOT EXISTS public.research_content_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_content_id uuid NOT NULL REFERENCES public.research_content(id) ON DELETE CASCADE,
  source_url text NOT NULL,
  source_domain text NULL,
  source_title text NULL,
  source_type text NULL,
  publisher_name text NULL,
  published_date text NULL,
  retrieved_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  is_primary_source boolean NOT NULL DEFAULT false,
  is_trusted boolean NOT NULL DEFAULT true,
  exclude_from_refresh boolean NOT NULL DEFAULT false,
  source_order integer NOT NULL DEFAULT 0,
  notes text NULL,
  excerpt_chars integer NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT research_content_sources_url_not_blank
    CHECK (length(trim(source_url)) > 0)
);

CREATE INDEX IF NOT EXISTS research_content_sources_parent_idx
  ON public.research_content_sources (research_content_id, source_order);

CREATE UNIQUE INDEX IF NOT EXISTS research_content_sources_url_uidx
  ON public.research_content_sources (research_content_id, source_url);

-- =========================================================
-- research_entity_aliases
-- =========================================================

CREATE TABLE IF NOT EXISTS public.research_entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  research_content_id uuid NULL REFERENCES public.research_content(id) ON DELETE CASCADE,
  entity_id uuid NULL,
  entity_key text NULL,
  alias text NOT NULL,
  normalised_alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT research_entity_aliases_type_check
    CHECK (entity_type IN ('ship', 'destination', 'port', 'cruise_line')),
  CONSTRAINT research_entity_aliases_alias_not_blank
    CHECK (length(trim(alias)) > 0),
  CONSTRAINT research_entity_aliases_norm_not_blank
    CHECK (length(trim(normalised_alias)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS research_entity_aliases_unique_norm_uidx
  ON public.research_entity_aliases (entity_type, normalised_alias);

CREATE INDEX IF NOT EXISTS research_entity_aliases_content_idx
  ON public.research_entity_aliases (research_content_id)
  WHERE research_content_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS research_entity_aliases_entity_key_idx
  ON public.research_entity_aliases (entity_type, entity_key)
  WHERE entity_key IS NOT NULL;

-- =========================================================
-- RLS
-- =========================================================

ALTER TABLE public.research_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_content_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.research_entity_aliases ENABLE ROW LEVEL SECURITY;

-- Public may read only published research_content (no drafts/notes exposure via RLS).
-- Internal diagnostics/notes are stripped by the public API; RLS still blocks drafts.
DROP POLICY IF EXISTS "Public read published research_content" ON public.research_content;
CREATE POLICY "Public read published research_content"
  ON public.research_content FOR SELECT
  TO anon, authenticated
  USING (content_status = 'published');

DROP POLICY IF EXISTS "Admins manage research_content" ON public.research_content;
CREATE POLICY "Admins manage research_content"
  ON public.research_content FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  );

-- Sources are admin-only (not public via PostgREST)
DROP POLICY IF EXISTS "Admins manage research_content_sources" ON public.research_content_sources;
CREATE POLICY "Admins manage research_content_sources"
  ON public.research_content_sources FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  );

DROP POLICY IF EXISTS "Admins manage research_entity_aliases" ON public.research_entity_aliases;
CREATE POLICY "Admins manage research_entity_aliases"
  ON public.research_entity_aliases FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.is_admin = true
    )
  );

-- Aliases for published entities may be read by public for matching helpers if needed later.
-- For this sprint, public matching is done server-side with service role.
DROP POLICY IF EXISTS "Public read aliases for published content" ON public.research_entity_aliases;
CREATE POLICY "Public read aliases for published content"
  ON public.research_entity_aliases FOR SELECT
  TO anon, authenticated
  USING (
    research_content_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.research_content rc
      WHERE rc.id = research_content_id AND rc.content_status = 'published'
    )
  );

COMMENT ON TABLE public.research_content IS
  'Sprint 10D reusable AI-assisted research content for ships, destinations, ports, and cruise lines.';
COMMENT ON TABLE public.research_content_sources IS
  'Traceability sources for research_content. Do not store full article copies.';
COMMENT ON TABLE public.research_entity_aliases IS
  'Normalised aliases for destination/port matching without unsafe fuzzy joins.';
