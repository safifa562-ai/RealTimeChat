# RealTimeChat — Publish checklist

## Before inviting public users
- [ ] Confirm the app works in a clean account on desktop and mobile.
- [ ] Test register/login, direct chat persistence, history, group messages, friend requests, file and voice messages, DP upload, calls and notifications.
- [ ] Run all required Supabase migrations against the exact project configured in Render.
- [ ] Verify Render `/health`, Supabase database access, Storage bucket, and the service-role key is only in Render Environment.
- [ ] Replace draft privacy/terms/support pages with truthful final wording and a monitored contact.
- [ ] Add and test report/block features and a process for handling abusive users/content.
- [ ] Add appropriate rate-limiting, abuse controls, backups, error monitoring and a recovery plan.
- [ ] Review accessibility, responsive screens, permission flows and service-worker update behavior.
- [ ] Test account deletion in a test account and confirm all expected storage/database cleanup.
- [ ] Do not claim E2E encryption until a proper cryptographic design is implemented and independently reviewed.

## Optional website revenue
- [ ] Use only a payment account that is legitimately owned/operated by the responsible adult/business and has completed provider verification.
- [ ] Run `monetization-migration.sql` in the correct Supabase project.
- [ ] Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in Render Environment, never GitHub.
- [ ] Test Razorpay test-mode checkout, cancellation, forged signature, captured status, duplicate verify, missing tables, refund/support process.
- [ ] Replace the sample ₹49 one-time amount and legal offer wording if you choose a different product/price.
- [ ] No payment/earnings guarantee. Do not collect payments until checkout, terms, support and refunds are ready.

## Google Play
For an Android app distributed through Google Play, in-app digital products/features generally require Google Play Billing unless a current policy exception/program applies. The Razorpay integration in this project is for the hosted website, not approved for embedding in a Play-distributed app by default.

- [ ] Run `supabase-feature-pack.sql`; verify 24-hour statuses, private signed media URLs, block/unblock enforcement, report creation, pinned messages, forwarding, and chat export.
- [ ] Confirm reports are reviewed by a responsible operator.
- [ ] Check status-media expiry cleanup and storage usage.
