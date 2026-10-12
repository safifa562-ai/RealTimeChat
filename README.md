# RealTimeChat diagnostic patch

## Included
- `server.js`: existing backend source, unchanged except bundled from the current project snapshot.
- `public/index.html`: same frontend plus clearer HTTP/history error handling and optional TURN configuration.
- `index.html`: duplicate root copy for reference only; serve `public/index.html`.
- `package.json`, `supabase-migration.sql`.

## Important: existing messages
The app's history endpoint reads `public.messages` using `sender_id`, `receiver_id`, and `created_at`. In Render logs, check for `HISTORY:` or `HISTORY ERROR:`. If you see a missing-column/table or permission error, fix the existing Supabase schema/policies. Do not delete the messages table or run destructive SQL. Confirm that the logged-in user's IDs match the IDs stored in `messages`.

## Video calls
The current WebRTC configuration has Google STUN only. That is not enough on some mobile networks, NATs, or restricted Wi-Fi. Configure a trusted TURN service, then expose its credentials safely to the frontend using a server-generated short-lived TURN credential or a private config endpoint. Do NOT put a long-lived TURN password directly in a public HTML file. `window.RTC_TURN_CONFIG` is an optional client config hook in this patch; only use short-lived credentials.

## Render env vars
Keep `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET` set in Render. Never put the service-role key in HTML or commit it to GitHub.

## Deploy
1. Back up the current GitHub repo.
2. Replace `server.js` and `package.json` only with files from this project snapshot if they match your current deployed code.
3. Upload `public/index.html` (ensure path is exactly `public/index.html`).
4. Commit changes; Render should deploy the new commit.
5. Test history with two users and inspect Render logs.
6. For calls, test with both users on different networks and valid HTTPS camera/microphone permissions; configure TURN for reliable connectivity.

This patch has not been deployed. It cannot restore history if messages were never saved to Supabase or fix schema/credentials without the exact logs.


## Separate source files
- `public/index.html`: page structure
- `public/style.css`: styles
- `public/app.js`: frontend JavaScript
- `server.js`: Node.js backend

The HTML references `/style.css` and `/app.js`. Keep all three files in the `public` folder.
