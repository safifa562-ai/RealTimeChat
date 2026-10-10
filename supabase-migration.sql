-- Run this in Supabase SQL Editor before deploying the updated app.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_edited boolean NOT NULL DEFAULT false;

-- The existing app expects these columns already:
-- is_deleted, is_read, message_type, file_name, file_url, file_size.
