# Media Library — one-time Supabase setup (Sprint 10C)

## 1. Apply the migration

Run in the Supabase SQL editor (or your usual migration path):

`supabase/migrations/20260721_media_library.sql`

This creates:

- Storage bucket `cruise-media` (public read, 10 MB, jpg/png/webp)
- Table `public.media_library`
- Columns `featured_cruises.hero_media_id` and `featured_cruises.route_map_media_id`
- Admin RLS on `media_library`
- Public SELECT policy on `storage.objects` for bucket `cruise-media`

## 2. Confirm the bucket

Supabase Dashboard → Storage → `cruise-media`

- Public bucket: **on**
- File size limit: **10 MB**
- Allowed MIME types: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`

If the bucket insert in the migration was skipped in your environment, create it manually with those settings.

## 3. Storage write security

Anonymous clients must **not** be able to INSERT/UPDATE/DELETE on `cruise-media`.

Uploads use Admin-authenticated Netlify function `media-library` (`create_upload`) which returns a **signed upload URL** via the service role. The browser uploads to that signed URL only.

Do not add broad anon write policies for this bucket.

## 4. Image transformations

This sprint does **not** require paid Supabase Image Transformations.

Thumbnails use the optimised uploaded file + CSS `object-fit` + `loading="lazy"`.

## 5. Netlify env

Ensure these remain set (server-side only):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Never expose the service-role key in client JavaScript.
