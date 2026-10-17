# RealTimeChat — full WhatsApp Web-inspired design

This is a design refresh for the existing RealTimeChat app. It preserves the current Node/Express, Socket.IO and Supabase backend and keeps the existing auth, messaging, friends, requests, groups, file upload, voice-note and call functions wired to their original JavaScript handlers.

## Full app layout update
- Desktop two-pane experience: contact navigation on the left and conversation on the right.
- Chats, Requests, Groups, and People tabs to keep the sidebar uncluttered.
- Contact initials, online indicators, search, connect-by-ID, group creation, and request actions.
- WhatsApp-inspired dark surfaces, outgoing green bubbles, incoming dark bubbles and compact message tools.
- Call/audio/video/screen-share buttons in the conversation header.
- Mobile layout switches to the active conversation with a back button.
- Chat history is the only main scrolling area; the composer and its attach, voice-note, and send controls remain separate fixed-size flex children.
- CSS, JavaScript, and service-worker cache version bumped so the browser can receive the update.

## Existing Render deployment
1. Back up your repository first.
2. For an existing repo, upload the five files in `public/` into the repository's existing `public/` folder, replacing matching files: `index.html`, `style.css`, `app.js`, `manifest.json`, `service-worker.js`.
3. Keep `server.js`, `package.json`, `.env.example`, and `supabase-migration.sql` at the repository root; do not put them in `public/`.
4. Commit the update and wait for Render to deploy it.
5. Open the site and hard-refresh (`Ctrl+Shift+R`). If installed as a PWA, close and reopen it so the updated service worker can activate.

## Environment/security
Keep `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `JWT_SECRET` in Render Environment settings. Never commit production secrets to the public repository.

## Checks and limitations
`node --check` is run against `server.js` and `public/app.js`; the stylesheet is parsed with `tinycss2`; static references to HTML IDs are checked. These checks do not prove that the live app's database, authentication, real-time messaging or WebRTC calls work. Deployment and visual/runtime testing against the user's Render service have not been performed here. WebRTC can need a TURN relay on restrictive networks. This application does not claim end-to-end encryption.


## Permanent account deletion
- Signed-in users can open the account options menu beside their profile and choose **Delete account**.
- The confirmation dialog explains the impact, requires the current password, and requires typing `DELETE`.
- The server verifies the password again before performing deletion. The endpoint is `DELETE /api/account` and requires the user's bearer token.
- It removes the user's direct messages and their reactions, friend requests, friendships, group memberships and authored group messages. Uploaded objects under that user's `chat-files` storage prefix are removed. Empty groups owned by that user are deleted; groups with other members are kept and ownership is transferred to an existing member where possible.
- This feature uses the existing `SUPABASE_SERVICE_ROLE_KEY` held in Render environment variables; never put it in frontend files or GitHub. No extra environment variable or SQL migration is required by this endpoint.
- Authenticated HTTP requests check that the account row still exists, so old bearer tokens stop working after deletion. Socket sessions are notified and disconnected too.
- Deletion across Supabase tables and Storage is not a single database transaction. If a database or Storage operation fails mid-way, the endpoint returns an error and logs the failed step; retry/administrative review may be needed. Back up important data before enabling account deletion in production.


## Notifications
- The app includes an in-app notification bell and toast notifications for incoming private messages outside the open conversation, group messages while another view is active, friend requests, friend-request acceptance, and incoming calls when the page is in the background.
- Click **Enable** in the notification bell panel to request browser notification permission. Native browser notifications show while the page is open in the background and permission is granted.
- Notification history is stored per signed-in account in that browser's local storage and can be cleared from the panel.
- This is not server-driven Web Push. Notifications cannot be delivered after the website/PWA is fully closed or when the user is offline; that requires a Web Push subscription, VAPID keys, and server-side push delivery.


## Profile display picture (DP)
- Sign in, then click the profile avatar or choose **Change profile photo** from the account menu.
- The API accepts JPG, PNG, or WebP images up to 5 MB, checks image signatures, uploads to a dedicated public `profile-avatars` Supabase Storage bucket under `<user-id>/avatars/`, and persists its public URL in `public.users.avatar_url`.
- Avatar URLs appear in the profile, the people/friends/requests lists, and the selected conversation header. Connected clients receive a `profile-updated` Socket.IO event.
- Run `supabase-profile-avatar.sql` in Supabase SQL Editor before uploading DPs. It adds `avatar_url` if missing and creates/configures a separate public `profile-avatars` bucket restricted to JPG, PNG, and WebP images up to 5 MB. This avoids changing visibility or size limits for `chat-files`. Keep `SUPABASE_SERVICE_ROLE_KEY` only in Render Environment, never in browser code/GitHub.
- This new endpoint has not been run against the live Supabase/Render deployment in this environment; test with a non-critical account first.


## DP upload troubleshooting
1. Run `supabase-profile-avatar.sql` in the exact Supabase project referenced by Render.
2. Verify Render Environment has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for that same project. Never reveal the service-role key.
3. Replace root `server.js` with this bundle's server code, replace the five frontend files inside the repository's `public/` folder, then deploy.
4. If it still fails, search Render Logs for `PROFILE AVATAR STORAGE` or `PROFILE AVATAR DB UPDATE`. Share only the error message/code; do not share secrets.
5. Account deletion cleans the user prefix from both `chat-files` and `profile-avatars`.

Runtime limitations: this has been syntax/static checked but not connected to the live Supabase or Render deployment; live upload still needs to be tested in the actual project.


## Profile avatar upload failure - diagnostic fix
- The avatar endpoint now verifies the profile-avatars bucket before upload and creates it if it is missing, using the server-only Supabase client.
- It logs safe error fields (`message`, `code`, `statusCode`, `name`) under `PROFILE AVATAR ERROR`, and returns a useful error message to the authenticated client. It never logs API keys.
- Profile URLs are stored in `public.users.avatar_url`. Run `supabase-profile-avatar.sql` in the same Supabase project configured in Render.
- In Render Environment, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must belong to that same project. Use a server secret/service-role key, never an anon/publishable key for server-side Storage uploads. Do not add public/anonymous Storage upload policies.
- Replacing this bundle does not itself deploy to Render. After GitHub commit, wait for deployment and test with a JPG/PNG/WebP image under 5 MB. The browser will show a more specific upload error if configuration still fails.


## Public launch and optional monetization (website only)

This bundle adds a one-time ₹49 Supporter checkout using Razorpay Standard Checkout for the website. It is intentionally **disabled until the operator configures the provider credentials**. This is not a recurring subscription and income is not guaranteed.

### Enable website checkout
1. Back up the database and confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Render point to the intended production project. Keep `SUPABASE_SERVICE_ROLE_KEY` private.
2. Run `monetization-migration.sql` in that same Supabase project's SQL Editor.
3. The responsible adult/business operator must complete the payment provider's eligibility, identity/business verification, bank/payout and tax steps. Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in Render Environment only. Start in test mode; configure live keys only after tests, terms, refund/support process and business arrangements have been reviewed. Never put the secret in GitHub or frontend files.
4. Redeploy. From a logged-in test account, open the account menu → Support RealTimeChat. Checkout will stay disabled when keys/tables are absent.
5. Test successful payment, cancelled payment, bad signature, order reuse, server/database errors and account deletion. Confirm the one-time Supporter badge only activates after the server validates Razorpay's signature and confirms the payment is captured.

The price (₹49, one-time) is a sample constant in `server.js` (`SUPPORTER_PRICE_PAISE`). Change it on the server and update the terms/dialog together before public sales. The app currently awards only a Supporter badge; do not advertise other paid benefits that are not implemented. Handle customer refunds and disputes with the verified payment provider dashboard and published support channel.

### Store distribution warning
This Razorpay checkout is for the hosted website/PWA only. If you distribute a wrapper/native app through Google Play and sell digital features, avatars, subscriptions or app functionality, review Google Play's current Payments policy; Play Billing is generally required for digital goods/services unless an explicitly applicable exception/program applies. Do not ship the website checkout inside a Play-distributed app without checking compliance.

### Launch checklist — not yet production-certified
- Replace template Privacy, Terms and Support pages with truthful final policy text and a monitored support contact; have the responsible operator review legal requirements.
- Implement/report-test block/report moderation flows before inviting the general public, especially because users can send unmoderated messages and files.
- Audit authentication, password reset, abuse rate limits, file uploads and account deletion; back up database before schema changes.
- Test message saving/history, group membership/ownership, DP upload, voice notes, browser notifications, mobile/responsive views and audio/video calling on multiple devices/network types. WebRTC can need TURN; this bundle only specifies the existing STUN configuration.
- Do not claim end-to-end encryption. The current chat is not independently verified as E2E encrypted.
- Verify dependency/security updates, app access/review credentials when applicable, custom domain, monitoring and incident response.
- Live Supabase, Razorpay and Render checks are still required. Syntax/static checks are not production certification.


## Ultimate feature pack: statuses, blocking, reporting, pin/forward/export
Run `supabase-feature-pack.sql` in the same Supabase project used by Render before using these additions.

- **24-hour statuses/stories**: text plus optional JPG/PNG/WebP/MP4/WebM media; private Storage bucket; signed URLs; friend-only visibility; 24-hour expiry; status views and delete-own-status. Expired media is cleaned opportunistically when status data is requested.
- **Block/unblock**: chat-header menu and a Blocked Users list in the Status panel; blocking removes the friendship and pending friend request, hides blocked accounts from discovery, and the server refuses private messages/call initiation for blocked pairs.
- **Report contact**: a server-side report is submitted with a reason and optional details. This creates a report record; there is no dedicated human moderation dashboard in this code, so an app operator must review reports in Supabase.
- **Pin/unpin messages**: personal pins per account and private conversation, up to 200 pinned rows per user.
- **Forward message**: forward a previously received/sent private message to a user ID; file media is referenced by the existing file URL, not copied to a new storage object.
- **Export chat**: exports current private chat history as a local text file.

The feature migration is additive and should not delete messages, but back up Supabase before applying it. The status bucket is private. The backend uses `SUPABASE_SERVICE_ROLE_KEY` and creates signed URLs; never expose that key in client code. Feature routes return explicit setup messages if the SQL has not been run.

Limitations: status/report/block/pin features have passed syntax/static checks in this package but have not been tested against your live Supabase or Render deployment. This app still does **not** claim end-to-end encryption, and WebRTC calling may require TURN credentials for restrictive networks. The moderation/report records need an operator review process for a public launch.


## Socket authentication hardening
Socket.IO now requires the same signed bearer token used by HTTP endpoints, checks that the account exists, and ignores client-supplied user IDs for socket identity. This is important for a public app because user IDs in browser events must not be trusted. Test login, reconnect, multi-tab use and logout after deploying.


## Group enhancements
Group chats can now send uploaded files/voice notes through the existing `chat-files` bucket, search group text history, and let a group creator add a member by User ID from the conversation header. Run `supabase-feature-pack.sql` first so `group_messages` has the file metadata columns.
