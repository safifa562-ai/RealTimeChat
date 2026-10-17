# RealTimeChat — DP / Profile Photo Setup

Is project mein profile photo (DP) upload feature included hai.

## DP kaise use karein
1. Project ko extract karein.
2. Render par `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, aur `JWT_SECRET` Environment Variables sahi set honi chahiye. Service-role key ko kabhi frontend ya GitHub par na rakhein.
3. Supabase Dashboard kholein → SQL Editor → New query.
4. Is project ki `supabase-profile-avatar.sql` file ka poora SQL paste karke Run karein. Yeh `public.users.avatar_url` column aur `profile-avatars` storage bucket set up karta hai.
5. Project ke latest source files GitHub mein update karke Render deploy karein.
6. Login karein → profile photo/circle ya `Change DP` par click karein → JPG, PNG, ya WebP image (maximum 5 MB) select karein.
7. Confirm karein ke DP profile aur contacts/chat list mein dikh rahi hai; phir doosre account se bhi verify karein.

## Agar DP upload fail ho
- Render aur Supabase ko same Supabase project use karna chahiye.
- Render logs mein `/api/profile/avatar` ke `PROFILE AVATAR` errors dekhein.
- `public.users` table par `avatar_url` column aur Supabase Storage mein `profile-avatars` bucket hona chahiye.
- Sirf SQL success hone se live site update nahi hoti; source code GitHub/Render par deploy karna zaroori hai.

## Important
- Yeh ZIP source package hai; isse tumhari live Render website ya GitHub repository automatically change nahi hoti.
- Public bucket mein uploaded profile photos public URL se dekhne layak hoti hain. Private photos ke liye alag signed-URL design chahiye.
