# RealTimeChat DP Upload Fix (Hindi)

Screenshot ka error: `Upload endpoint returned a non-JSON response (HTTP 200)`.

Iska matlab browser ne `/api/profile/avatar` request bheji, response status `200` aaya, lekin response JSON nahi tha. Is project mein sabse likely reason hai ki frontend ka naya `public/app.js` deploy hua hai par Render par purana/different `server.js` chal raha hai; purana Express frontend fallback `index.html` ko HTTP 200 ke saath bhej sakta hai. Is message se Supabase bucket ko primary cause nahi maana ja sakta.

## Fix steps

1. ZIP extract karo. GitHub repo `safifa562-ai/RealTimeChat` mein **matching project root** par `server.js`, `public/app.js` aur baaki files replace/upload karo. `server.js` ko kisi extra nested folder mein mat chhodo.
2. GitHub par `server.js` khol kar confirm karo ki `app.post("/api/profile/avatar"` aur `app.get("/api/version"` dono maujood hain.
3. Render Dashboard → RealTimeChat service → **Settings** mein `Root Directory` verify karo (blank, agar files repo root mein hain) aur Start Command `node server.js` ho, agar wahi project layout use kar raha hai.
4. Render → **Manual Deploy** → **Clear build cache & deploy** (ya latest commit deploy) karo; deploy logs mein `RealTimeChat running on port ...` aaye.
5. Deploy complete hone ke baad browser mein `https://realtimechat-9.onrender.com/api/version` kholo. JSON mein `release: dp-upload-diagnostic-2026-10-17` dikhna chahiye. Agar website `index.html`, `Cannot GET`, ya old/different response dikha rahi hai, toh backend abhi matching version par nahi hai—Root Directory/Start Command/repo branch check karo.
6. App hard refresh karo (`Ctrl + Shift + R`), phir DP upload dobara try karo.

## Agar ab bhi fail hota hai

Matching backend deploy ke baad error JSON mein actual message aana chahiye—jaise profile-avatars bucket missing, DB column missing, ya storage permission. Usi exact error ka screenshot bhejo. Supabase SQL sirf us specific error par run karo.

## Safety

`SUPABASE_SERVICE_ROLE_KEY` aur `JWT_SECRET` sirf Render Environment mein rakho. Inhe GitHub, browser JS, screenshot ya public chat mein mat daalo.

**Note:** Yeh package code/path diagnostic add karta hai; live Render site ko yahan se deploy nahi kiya gaya aur real account se upload test nahi hua.
