# RealTimeChat — Five-feature update bundle

Included features:
1. Edit your own text messages within 15 minutes.
2. Delete for everyone (existing soft-delete feature retained).
3. Voice notes using browser microphone + existing Supabase Storage upload.
4. Basic app screen lock (casual privacy only; not a security boundary).
5. Mute unknown callers + filter loaded messages (All / Text / Files).

## Before replacing files
- Download a backup of your current GitHub repository.
- This bundle is based on the supplied RealTimeChat source. Do not overwrite the entire repository blindly.
- Copy `server.js` to the repository root, and copy `public/index.html` to the existing `public/index.html` location. If your repo currently serves `index.html` from another folder, follow that repo's actual layout instead.
- Keep your existing Render environment variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET`. Never put secrets in these files or GitHub.
- In Supabase SQL Editor, run `supabase-migration.sql` first.
- Ensure `package.json` dependencies are installed by Render (`npm install`) and Start Command is `node server.js`.

## Important limitations
- The app lock is only a convenience screen lock; anyone with access to developer tools/browser storage can bypass it.
- “Mute unknown callers” hides the incoming-call prompt for non-friends in this client; it is not a server-side call-blocking security feature.
- Voice notes upload to the existing `chat-files` Supabase Storage bucket. Make sure the bucket supports your intended access policy. The current server returns public URLs; do not use sensitive media with a public bucket.
- This is not end-to-end encryption. Do not claim chats or calls are end-to-end encrypted.
- Test in a preview/staging deployment first. I have not deployed these files to your live Render app.
