# RealTimeChat — Full Source Code

This ZIP contains the whole project source: backend, frontend HTML/CSS/JavaScript, PWA shell, and the included Supabase migration. It is based on the existing RealTimeChat project and includes the chat-panel layout/scrolling fix. It is source code, not a claim that the live Render deployment has been updated or production-tested.

## Files
- `server.js` — Express + Socket.IO + Supabase backend
- `package.json` — dependencies and start script
- `public/index.html` — app markup
- `public/style.css` — visual design and responsive layout
- `public/app.js` — client-side app logic
- `public/manifest.json` and `public/service-worker.js` — basic PWA support
- `supabase-migration.sql` — small message-column migration included with this source
- `.env.example` — environment variable names only (no secrets)

## Deploy to the existing Render app
1. Back up your GitHub repository before replacing files.
2. Extract the ZIP. Upload the project files/folders to the root of your GitHub repository, preserving `public/` as a folder.
3. Keep Render's start command as `node server.js` (or use `npm start`).
4. In Render → Environment, set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET`. Keep the service-role key and JWT secret private; do not commit them to GitHub.
5. Commit/push and wait for Render deploy to finish. Then use `Ctrl+Shift+R` to refresh the page.
6. If required by your existing database schema, review `supabase-migration.sql` and run it in the Supabase SQL Editor after taking a database backup.

## Notes
- `node --check server.js` and `node --check public/app.js` check JavaScript syntax only; they do not test live database permissions, authentication, messages, or calls.
- Audio/video calling can require a TURN server on some networks; this bundle does not configure one.
- The existing app is not end-to-end encrypted. Do not advertise it as E2E-encrypted without a separate, reviewed implementation.
