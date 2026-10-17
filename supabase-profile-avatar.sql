-- RealTimeChat profile avatar setup. Run in the Supabase project used by Render.
-- Public means images may be viewed by URL; uploads/updates are performed by the server only.
-- Do NOT add an anonymous INSERT policy for this bucket.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, UPDATE ON TABLE public.users TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('profile-avatars', 'profile-avatars', TRUE, 5242880, ARRAY['image/jpeg','image/png','image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = TRUE,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp']::text[];

NOTIFY pgrst, 'reload schema';
COMMIT;
