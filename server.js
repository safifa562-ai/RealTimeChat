const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE"]
  }
});

const PORT = process.env.PORT || 10000;

/* =========================================================
   SUPABASE
========================================================= */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET =
  process.env.JWT_SECRET;

// Optional website-only monetization. Leave blank to keep checkout disabled.
const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "").trim();
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const SUPPORTER_PRICE_PAISE = 4900; // ₹49 one-time; change only after reviewing the offer/terms.
const SUPPORTER_CURRENCY = "INR";

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !JWT_SECRET
) {
  console.error(
    "Missing Supabase/JWT environment variables"
  );

  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Optional social-safety feature tables are enabled by supabase-feature-pack.sql.
function isMissingFeatureTable(error, tableName) {
  const code = String(error && error.code || "");
  const message = String(error && error.message || "").toLowerCase();
  return ["42P01", "PGRST205", "PGRST204"].includes(code) ||
    (message.includes(tableName.toLowerCase()) && (message.includes("does not exist") || message.includes("could not find the table") || message.includes("schema cache")));
}

async function areUsersBlocked(userA, userB) {
  const a = Number(userA), b = Number(userB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return false;
  const { data, error } = await supabase.from("user_blocks").select("blocker_id").or(
    `and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`
  ).limit(1);
  if (error) {
    // Existing deployments remain usable until the additive feature SQL is run.
    if (isMissingFeatureTable(error, "user_blocks")) return false;
    throw error;
  }
  return Array.isArray(data) && data.length > 0;
}

// Authenticate Socket.IO connections with the same signed token as HTTP routes.
// Never trust a client-supplied user ID to establish socket identity.
io.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth && socket.handshake.auth.token) || "").trim();
    if (!token) return next(new Error("Authentication required"));
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = Number(payload && payload.id);
    if (!Number.isInteger(userId) || userId < 1) return next(new Error("Invalid session"));
    const { data: account, error } = await supabase.from("users").select("id,username").eq("id", userId).maybeSingle();
    if (error) {
      console.error("SOCKET AUTH DB:", { code: error.code, message: error.message });
      return next(new Error("Could not verify account"));
    }
    if (!account) return next(new Error("Account no longer exists"));
    socket.userId = String(account.id);
    socket.username = String(account.username || "");
    return next();
  } catch (error) {
    return next(new Error("Invalid or expired session"));
  }
});

/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  // Razorpay Checkout uses a popup/postMessage flow.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// Build diagnostic: open /api/version after deployment to verify the backend
// has the profile-avatar API included in this release.
app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    app: "RealTimeChat",
    release: "dp-upload-diagnostic-2026-10-17",
    profileAvatarEndpoint: "POST /api/profile/avatar"
  });
});


/* =========================================================
   EDIT MESSAGE (sender only, within 15 minutes)
   Requires messages.is_edited boolean default false.
========================================================= */
app.patch("/api/messages/:id/edit", authMiddleware, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const text = String(req.body.message || "").trim();
    if (!Number.isInteger(messageId) || messageId < 1 || !text || text.length > 4000) {
      return res.status(400).json({ error: "Message must be 1–4000 characters." });
    }

    const { data: existing, error: readError } = await supabase
      .from("messages")
      .select("id,sender_id,receiver_id,message,message_type,created_at,is_deleted")
      .eq("id", messageId)
      .maybeSingle();

    if (readError || !existing) return res.status(404).json({ error: "Message not found." });
    if (Number(existing.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can only edit your own messages." });
    }
    if (existing.is_deleted) return res.status(400).json({ error: "Deleted messages cannot be edited." });
    if (existing.message_type && existing.message_type !== "text") {
      return res.status(400).json({ error: "Only text messages can be edited." });
    }
    const createdAt = new Date(existing.created_at).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60 * 1000 || Date.now() < createdAt) {
      return res.status(400).json({ error: "Messages can only be edited within 15 minutes." });
    }

    const { data: updated, error: updateError } = await supabase
      .from("messages")
      .update({ message: text, is_edited: true })
      .eq("id", messageId)
      .select("*")
      .single();

    if (updateError) {
      console.error("EDIT MESSAGE:", updateError);
      return res.status(500).json({ error: "Could not edit message. Check the SQL migration was run." });
    }

    io.emit("message-edited", updated);
    res.json({ success: true, message: updated });
  } catch (error) {
    console.error("EDIT MESSAGE ERROR:", error);
    res.status(500).json({ error: "Edit failed." });
  }
});

/* =========================================================
   FILE UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize:
      100 * 1024 * 1024
  }
});

// Profile pictures use a separate 5 MB image-only upload limit.
const profileAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(String(file.mimetype || "").toLowerCase())) {
      return callback(new Error("Choose a JPG, PNG, or WebP image."));
    }
    callback(null, true);
  }
});

function handleProfileAvatarUpload(req, res, next) {
  profileAvatarUpload.single("avatar")(req, res, error => {
    if (!error) return next();
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "Profile picture must be 5 MB or smaller."
        : (error.message || "Invalid profile picture.")
    });
  });
}

const statusMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]);
    if (!allowed.has(String(file.mimetype || "").toLowerCase())) {
      return callback(new Error("Choose a JPG, PNG, WebP, MP4, or WebM file."));
    }
    callback(null, true);
  }
});

function handleStatusMediaUpload(req, res, next) {
  statusMediaUpload.single("media")(req, res, error => {
    if (!error) return next();
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      error: error.code === "LIMIT_FILE_SIZE"
        ? "A status photo/video must be 20 MB or smaller."
        : (error.message || "Invalid status media file.")
    });
  });
}

function validStatusMediaSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType.startsWith("image/")) return validImageSignature(buffer, mimeType);
  if (mimeType === "video/mp4") return buffer.toString("ascii", 4, 8) === "ftyp";
  if (mimeType === "video/webm") return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

async function ensureStatusMediaBucket() {
  const { data, error } = await supabase.storage.getBucket("status-media");
  if (!error && data) return;
  const missing = String(error && error.message || "").toLowerCase().includes("not found") || String(error && error.statusCode || "") === "404";
  if (!missing) throw error || new Error("Could not inspect status-media bucket");
  const { error: createError } = await supabase.storage.createBucket("status-media", {
    public: false,
    fileSizeLimit: 20 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]
  });
  if (createError && !String(createError.message || "").toLowerCase().includes("already exists")) throw createError;
}

function validImageSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function ownAvatarPathFromPublicUrl(publicUrl, userId) {
  try {
    const parsed = new URL(publicUrl);
    const marker = "/storage/v1/object/public/profile-avatars/";
    const index = parsed.pathname.indexOf(marker);
    if (index < 0) return null;
    const objectPath = decodeURIComponent(parsed.pathname.slice(index + marker.length));
    return objectPath.startsWith(`${userId}/avatars/`) ? objectPath : null;
  } catch (_) {
    return null;
  }
}

/* =========================================================
   AUTH
========================================================= */

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

async function authMiddleware(
  req,
  res,
  next
) {
  let decoded;
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    decoded = jwt.verify(header.substring(7), JWT_SECRET);
    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Reject tokens belonging to accounts that have been permanently deleted.
  try {
    const { data: activeUser, error } = await supabase
      .from("users")
      .select("id")
      .eq("id", decoded.id)
      .maybeSingle();

    if (error) {
      console.error("AUTH ACCOUNT CHECK:", error);
      return res.status(503).json({ error: "Could not verify your account. Please try again." });
    }
    if (!activeUser) {
      return res.status(401).json({ error: "This account no longer exists. Please log in again." });
    }
    req.user = decoded;
    return next();
  } catch (error) {
    console.error("AUTH ACCOUNT CHECK ERROR:", error);
    return res.status(503).json({ error: "Could not verify your account. Please try again." });
  }
}

/* =====================================================
   RAZORPAY WEBSITE CHECKOUT (optional, one-time ₹49 supporter pass)
   Never trust client-side price/status. Payment activates only after
   backend signature and Razorpay payment status verification.
===================================================== */
function razorpayConfigured() {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

async function razorpayApi(pathname, options = {}) {
  const response = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const message = data && data.error && data.error.description;
    const error = new Error(String(message || `Razorpay request failed (${response.status})`).slice(0, 220));
    error.status = response.status;
    throw error;
  }
  return data;
}

function missingBillingTable(error) {
  const code = String(error && error.code || "");
  const message = String(error && error.message || "");
  return code === "42P01" || code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(message);
}

app.get("/api/premium/status", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("user_premium")
      .select("user_id, plan, purchased_at")
      .eq("user_id", Number(req.user.id))
      .maybeSingle();

    if (error) {
      if (missingBillingTable(error)) {
        return res.status(503).json({
          enabled: razorpayConfigured(), isPremium: false,
          error: "Premium database setup is missing. Run monetization-migration.sql in your Supabase project."
        });
      }
      console.error("PREMIUM STATUS:", { code: error.code, message: error.message });
      return res.status(500).json({ error: "Could not load supporter status." });
    }
    res.json({
      enabled: razorpayConfigured(),
      isPremium: Boolean(data),
      plan: data ? data.plan : null,
      purchasedAt: data ? data.purchased_at : null,
      price: SUPPORTER_PRICE_PAISE,
      currency: SUPPORTER_CURRENCY
    });
  } catch (error) {
    console.error("PREMIUM STATUS ERROR:", { message: error.message, code: error.code });
    res.status(500).json({ error: "Could not load supporter status." });
  }
});

app.post("/api/billing/razorpay/order", authMiddleware, async (req, res) => {
  if (!razorpayConfigured()) {
    return res.status(503).json({ error: "Online checkout is not enabled yet. The app owner must configure Razorpay keys in Render Environment." });
  }
  const userId = Number(req.user.id);
  try {
    const { data: existing, error: existingError } = await supabase
      .from("user_premium")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existingError) {
      if (missingBillingTable(existingError)) return res.status(503).json({ error: "Run monetization-migration.sql in Supabase before enabling checkout." });
      console.error("PREMIUM EXISTING CHECK:", { code: existingError.code, message: existingError.message });
      return res.status(500).json({ error: "Could not check supporter status." });
    }
    if (existing) return res.status(409).json({ error: "This account already has the Supporter badge." });

    const receipt = `rtc${userId}_${Date.now()}`.slice(0, 40);
    const order = await razorpayApi("/orders", {
      method: "POST",
      body: {
        amount: SUPPORTER_PRICE_PAISE,
        currency: SUPPORTER_CURRENCY,
        receipt,
        notes: { app: "RealTimeChat", user_id: String(userId), product: "supporter_one_time" }
      }
    });
    if (!order || !order.id || Number(order.amount) !== SUPPORTER_PRICE_PAISE || order.currency !== SUPPORTER_CURRENCY) {
      console.error("RAZORPAY ORDER INVALID RESPONSE");
      return res.status(502).json({ error: "Payment provider returned an unexpected order. Please try again." });
    }

    const { error: saveError } = await supabase.from("premium_purchases").insert({
      order_id: order.id,
      user_id: userId,
      amount: SUPPORTER_PRICE_PAISE,
      currency: SUPPORTER_CURRENCY,
      status: "created"
    });
    if (saveError) {
      console.error("PREMIUM ORDER SAVE:", { code: saveError.code, message: saveError.message });
      return res.status(500).json({ error: missingBillingTable(saveError) ? "Run monetization-migration.sql in Supabase before enabling checkout." : "Could not save the payment order. Please try again." });
    }

    res.json({ keyId: RAZORPAY_KEY_ID, orderId: order.id, amount: SUPPORTER_PRICE_PAISE, currency: SUPPORTER_CURRENCY, name: "RealTimeChat", description: "One-time Supporter pass" });
  } catch (error) {
    console.error("RAZORPAY CREATE ORDER:", { status: error.status, message: error.message });
    res.status(502).json({ error: "Could not start checkout. Check Razorpay live/test configuration and try again." });
  }
});

app.post("/api/billing/razorpay/verify", authMiddleware, async (req, res) => {
  if (!razorpayConfigured()) return res.status(503).json({ error: "Online checkout is not configured." });
  const orderId = String(req.body && req.body.razorpay_order_id || "");
  const paymentId = String(req.body && req.body.razorpay_payment_id || "");
  const signature = String(req.body && req.body.razorpay_signature || "");
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return res.status(400).json({ error: "Payment verification details are invalid." });
  }

  try {
    const { data: purchase, error: purchaseError } = await supabase
      .from("premium_purchases")
      .select("order_id,user_id,amount,currency,status,payment_id")
      .eq("order_id", orderId)
      .eq("user_id", Number(req.user.id))
      .maybeSingle();
    if (purchaseError) {
      if (missingBillingTable(purchaseError)) return res.status(503).json({ error: "Run monetization-migration.sql in Supabase before verifying payments." });
      console.error("PREMIUM PURCHASE LOOKUP:", { code: purchaseError.code, message: purchaseError.message });
      return res.status(500).json({ error: "Could not verify this purchase." });
    }
    if (!purchase) return res.status(404).json({ error: "Payment order does not belong to this account." });
    if (Number(purchase.amount) !== SUPPORTER_PRICE_PAISE || purchase.currency !== SUPPORTER_CURRENCY) {
      return res.status(400).json({ error: "Payment amount did not match the order." });
    }

    const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return res.status(400).json({ error: "Payment signature could not be verified." });
    }

    if (purchase.status !== "paid" || purchase.payment_id !== paymentId) {
      let payment = await razorpayApi(`/payments/${encodeURIComponent(paymentId)}`);
      if (payment.order_id !== orderId || Number(payment.amount) !== SUPPORTER_PRICE_PAISE || payment.currency !== SUPPORTER_CURRENCY) {
        return res.status(400).json({ error: "Payment details do not match this order." });
      }
      if (payment.status === "authorized") {
        payment = await razorpayApi(`/payments/${encodeURIComponent(paymentId)}/capture`, {
          method: "POST", body: { amount: SUPPORTER_PRICE_PAISE, currency: SUPPORTER_CURRENCY }
        });
      }
      if (payment.status !== "captured") {
        return res.status(409).json({ error: "Payment has not been captured yet. If money was deducted, wait a minute and try again before paying again." });
      }

      const { error: updatePurchaseError } = await supabase.from("premium_purchases")
        .update({ status: "paid", payment_id: paymentId, paid_at: new Date().toISOString() })
        .eq("order_id", orderId).eq("user_id", Number(req.user.id));
      if (updatePurchaseError) {
        console.error("PREMIUM PURCHASE UPDATE:", { code: updatePurchaseError.code, message: updatePurchaseError.message });
        return res.status(500).json({ error: "Payment is verified, but supporter status could not be saved. Contact support before paying again." });
      }
    }

    const { error: premiumError } = await supabase.from("user_premium").upsert({
      user_id: Number(req.user.id),
      plan: "supporter",
      purchase_order_id: orderId,
      purchased_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (premiumError) {
      console.error("PREMIUM ACTIVATE:", { code: premiumError.code, message: premiumError.message });
      return res.status(500).json({ error: "Payment is verified, but the Supporter badge could not be activated. Contact support with your payment ID." });
    }

    res.json({ success: true, isPremium: true, plan: "supporter", message: "Thank you for supporting RealTimeChat! Your Supporter badge is active." });
  } catch (error) {
    console.error("RAZORPAY VERIFY ERROR:", { status: error.status, message: error.message });
    res.status(502).json({ error: "Could not verify payment with the provider. Do not pay again yet; refresh supporter status or contact support." });
  }
});

/* =========================================================
   REGISTER
========================================================= */

app.post(
  "/api/register",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ""
        );

      if (
        !username ||
        !password
      ) {
        return res.status(400).json({
          error:
            "Username and password are required"
        });
      }

      if (
        username.length < 3
      ) {
        return res.status(400).json({
          error:
            "Username must be at least 3 characters"
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          error:
            "Password must be at least 6 characters"
        });
      }

      const {
        data: existing,
        error: existingError
      } = await supabase
        .from("users")
        .select("id")
        .eq(
          "username",
          username
        )
        .maybeSingle();

      if (existingError) {

        console.error(
          "REGISTER CHECK:",
          existingError
        );

        return res.status(500).json({
          error:
            "Database error"
        });
      }

      if (existing) {
        return res.status(409).json({
          error:
            "Username already exists"
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const {
        data: user,
        error
      } = await supabase
        .from("users")
        .insert({
          username,
          password_hash:
            passwordHash
        })
        .select(
          "id, username, avatar_url, created_at"
        )
        .single();

      if (error) {

        console.error(
          "REGISTER:",
          error
        );

        return res.status(500).json({
          error:
            "Registration failed"
        });
      }

      const token =
        createToken(user);

      res.status(201).json({
        message:
          "Account created",
        token,
        user
      });

    } catch (error) {

      console.error(
        "REGISTER ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Registration failed"
      });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ""
        );

      const {
        data: user,
        error
      } = await supabase
        .from("users")
        .select(
          "id, username, password_hash, avatar_url, created_at"
        )
        .eq(
          "username",
          username
        )
        .maybeSingle();

      if (error) {

        console.error(
          "LOGIN DB:",
          error
        );

        return res.status(500).json({
          error:
            "Database error"
        });
      }

      if (!user) {
        return res.status(401).json({
          error:
            "Invalid username or password"
        });
      }

      const valid =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          error:
            "Invalid username or password"
        });
      }

      await supabase
        .from("users")
        .update({
          last_seen:
            new Date().toISOString()
        })
        .eq(
          "id",
          user.id
        );

      delete user.password_hash;

      const token =
        createToken(user);

      res.json({
        message:
          "Login successful",
        token,
        user
      });

    } catch (error) {

      console.error(
        "LOGIN ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Login failed"
      });
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {

    try {

      const {
        data,
        error
      } = await supabase
        .from("users")
        .select(
          "id, username, avatar_url, created_at, last_seen"
        )
        .eq(
          "id",
          req.user.id
        )
        .single();

      if (error) {

        console.error(
          "ME:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load profile"
        });
      }

      res.json(data);

    } catch (error) {

      console.error(
        "ME ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not load profile"
      });
    }
  }
);

/* =========================================================
   PROFILE PICTURE (DISPLAY PICTURE)
   Stores profile images in the dedicated public profile-avatars bucket.
========================================================= */
async function ensureProfileAvatarBucket() {
  const bucketName = "profile-avatars";
  const { data: bucket, error: getError } = await supabase.storage.getBucket(bucketName);
  if (bucket && !getError) return bucket;

  // Only try creating the bucket when Supabase explicitly says it is missing.
  const lookupMessage = String((getError && getError.message) || "");
  const missing = /not found|does not exist|404/i.test(lookupMessage) || String(getError && getError.statusCode) === "404";
  if (!missing) {
    const err = new Error(`Cannot access Storage bucket '${bucketName}': ${lookupMessage || "unknown Storage error"}`);
    err.code = getError && getError.statusCode;
    throw err;
  }

  const { data: created, error: createError } = await supabase.storage.createBucket(bucketName, {
    public: true,
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"]
  });
  if (createError && !/already exists/i.test(String(createError.message || ""))) {
    const err = new Error(`Cannot create Storage bucket '${bucketName}': ${createError.message || "unknown Storage error"}`);
    err.code = createError.statusCode;
    throw err;
  }
  return created || { name: bucketName, public: true };
}
app.post("/api/profile/avatar", authMiddleware, handleProfileAvatarUpload, async (req, res) => {
  const userId = Number(req.user.id);
  if (!req.file) return res.status(400).json({ error: "Choose a profile picture first." });

  const mimeType = String(req.file.mimetype || "").toLowerCase();
  if (!validImageSignature(req.file.buffer, mimeType)) {
    return res.status(400).json({ error: "That file is not a valid JPG, PNG, or WebP image." });
  }

  const extensionByMime = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = extensionByMime[mimeType];
  const storagePath = `${userId}/avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

  try {
    await ensureProfileAvatarBucket();

    const { data: existingUser, error: lookupError } = await supabase
      .from("users")
      .select("id, username, avatar_url")
      .eq("id", userId)
      .maybeSingle();

    if (lookupError || !existingUser) {
      console.error("PROFILE AVATAR USER LOOKUP:", lookupError);
      return res.status(500).json({ error: "Could not load your profile. Please try again." });
    }

    const { error: storageError } = await supabase.storage
      .from("profile-avatars")
      .upload(storagePath, req.file.buffer, {
        contentType: mimeType,
        cacheControl: "3600",
        upsert: false
      });

    if (storageError) {
      console.error("PROFILE AVATAR STORAGE:", {
        message: storageError.message,
        statusCode: storageError.statusCode,
        error: storageError.error
      });
      const storageMessage = String(storageError.message || "");
      if (/bucket.*not found|not found.*bucket/i.test(storageMessage) || String(storageError.statusCode) === "404") {
        return res.status(503).json({ error: "Profile photo storage is not set up yet. Run supabase-profile-avatar.sql in the correct Supabase project, then try again." });
      }
      if (/mime|content.?type|file type/i.test(storageMessage)) {
        return res.status(400).json({ error: "Supabase Storage rejected this image type. Choose a JPG, PNG, or WebP image and check the profile-avatars bucket settings." });
      }
      return res.status(500).json({
        error: `Supabase could not store the profile photo: ${storageMessage || "unknown Storage error"}. Check that Render SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY belong to this same project.`,
        code: storageError.statusCode || storageError.error || "STORAGE_UPLOAD_FAILED"
      });
    }

    const { data: publicData } = supabase.storage.from("profile-avatars").getPublicUrl(storagePath);
    const avatarUrl = publicData && publicData.publicUrl;
    if (!avatarUrl) {
      await supabase.storage.from("profile-avatars").remove([storagePath]);
      return res.status(500).json({ error: "Could not create a profile photo URL." });
    }

    const { data: updatedUser, error: updateError } = await supabase
      .from("users")
      .update({ avatar_url: avatarUrl })
      .eq("id", userId)
      .select("id, username, avatar_url")
      .single();

    if (updateError || !updatedUser) {
      console.error("PROFILE AVATAR DB UPDATE:", updateError);
      await supabase.storage.from("profile-avatars").remove([storagePath]);
      return res.status(500).json({
        error: `Photo uploaded but profile could not be updated: ${(updateError && updateError.message) || "unknown database error"}. Check public.users.avatar_url and Render Supabase credentials.`,
        code: (updateError && updateError.code) || "PROFILE_UPDATE_FAILED"
      });
    }

    // Remove the previous image only if it belongs to this user's avatar folder.
    const oldPath = ownAvatarPathFromPublicUrl(existingUser.avatar_url, userId);
    if (oldPath && oldPath !== storagePath) {
      const { error: removeError } = await supabase.storage.from("profile-avatars").remove([oldPath]);
      if (removeError) console.warn("OLD PROFILE AVATAR CLEANUP:", removeError.message || removeError);
    }

    const event = { userId, username: updatedUser.username, avatar_url: updatedUser.avatar_url };
    io.emit("profile-updated", event);
    return res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error("PROFILE AVATAR ERROR:", {
      message: error && error.message,
      code: error && error.code,
      statusCode: error && error.statusCode,
      name: error && error.name
    });
    const details = String((error && error.message) || "Unknown server error").slice(0, 220);
    return res.status(500).json({ error: `Could not save profile picture: ${details}` });
  }
});

/* =========================================================
   STATUS / STORIES (expire after 24 hours)
   Status media is stored in a private bucket. API returns short-lived signed URLs.
========================================================= */
let lastStatusCleanupAt = 0;
async function cleanupExpiredStatuses() {
  if (Date.now() - lastStatusCleanupAt < 5 * 60 * 1000) return;
  lastStatusCleanupAt = Date.now();
  try {
    const { data: expired, error } = await supabase.from("user_statuses")
      .select("id,media_path").lt("expires_at", new Date().toISOString()).limit(250);
    if (error) { if (!isMissingFeatureTable(error, "user_statuses")) console.warn("STATUS CLEANUP LOOKUP:", error.message); return; }
    const rows = expired || [];
    const paths = rows.map(row => row.media_path).filter(Boolean);
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from("status-media").remove(paths);
      if (storageError) console.warn("STATUS CLEANUP STORAGE:", storageError.message);
    }
    if (rows.length) {
      const { error: deleteError } = await supabase.from("user_statuses").delete().in("id", rows.map(row => row.id));
      if (deleteError) console.warn("STATUS CLEANUP ROWS:", deleteError.message);
    }
  } catch (error) {
    console.warn("STATUS CLEANUP:", error && error.message);
  }
}

app.get("/api/statuses", authMiddleware, async (req, res) => {
  try {
    await cleanupExpiredStatuses();
    const userId = Number(req.user.id);
    const { data: friendships, error: friendshipError } = await supabase.from("friendships").select("friend_id").eq("user_id", userId);
    if (friendshipError) return res.status(500).json({ error: "Could not check status visibility." });
    const allowedIds = Array.from(new Set([userId, ...(friendships || []).map(row => Number(row.friend_id)).filter(Number.isInteger)]));
    const { data: rows, error } = await supabase.from("user_statuses").select("id,user_id,content,media_path,media_type,created_at,expires_at")
      .in("user_id", allowedIds).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(300);
    if (error) {
      console.error("STATUS LIST:", { code: error.code, message: error.message });
      return res.status(503).json({ error: isMissingFeatureTable(error, "user_statuses") ? "Status feature is not set up. Run supabase-feature-pack.sql in Supabase." : "Could not load statuses." });
    }
    const statuses = rows || [];
    const authorIds = Array.from(new Set(statuses.map(row => Number(row.user_id))));
    const statusIds = statuses.map(row => row.id);
    let authors = [];
    let views = [];
    if (authorIds.length) {
      const authorResult = await supabase.from("users").select("id,username,avatar_url").in("id", authorIds);
      if (authorResult.error) return res.status(500).json({ error: "Could not load status profiles." });
      authors = authorResult.data || [];
    }
    if (statusIds.length) {
      const viewResult = await supabase.from("status_views").select("status_id,viewer_id").in("status_id", statusIds);
      if (viewResult.error && !isMissingFeatureTable(viewResult.error, "status_views")) return res.status(500).json({ error: "Could not load status views." });
      views = viewResult.data || [];
    }
    const authorMap = new Map(authors.map(author => [Number(author.id), author]));
    const viewMap = new Map();
    for (const view of views) {
      const key = String(view.status_id);
      if (!viewMap.has(key)) viewMap.set(key, []);
      viewMap.get(key).push(Number(view.viewer_id));
    }
    const result = await Promise.all(statuses.map(async status => {
      let mediaUrl = null;
      if (status.media_path) {
        const signed = await supabase.storage.from("status-media").createSignedUrl(status.media_path, 60 * 60);
        if (!signed.error && signed.data) mediaUrl = signed.data.signedUrl;
      }
      const author = authorMap.get(Number(status.user_id)) || {};
      const viewers = viewMap.get(String(status.id)) || [];
      return {
        id: status.id, user_id: status.user_id, content: status.content,
        media_type: status.media_type, media_url: mediaUrl,
        created_at: status.created_at, expires_at: status.expires_at,
        username: author.username || `User ${status.user_id}`,
        avatar_url: author.avatar_url || null,
        view_count: Number(status.user_id) === userId ? viewers.length : undefined,
        viewed_by_me: viewers.includes(userId)
      };
    }));
    res.json(result);
  } catch (error) {
    console.error("STATUS LIST ERROR:", { code: error.code, message: error.message });
    res.status(500).json({ error: "Could not load statuses." });
  }
});

app.post("/api/statuses", authMiddleware, handleStatusMediaUpload, async (req, res) => {
  let uploadedPath = null;
  try {
    const userId = Number(req.user.id);
    const content = String(req.body.content || "").trim();
    const media = req.file || null;
    if (content.length > 700) return res.status(400).json({ error: "Status text must be 700 characters or fewer." });
    if (!content && !media) return res.status(400).json({ error: "Write a status or choose a photo/video." });
    if (media && !validStatusMediaSignature(media.buffer, String(media.mimetype || "").toLowerCase())) {
      return res.status(400).json({ error: "The selected file does not match a supported image/video format." });
    }
    if (media) {
      await ensureStatusMediaBucket();
      const extByType = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };
      const pathName = `${userId}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${extByType[media.mimetype]}`;
      const { error: storageError } = await supabase.storage.from("status-media").upload(pathName, media.buffer, { contentType: media.mimetype, upsert: false });
      if (storageError) {
        console.error("STATUS MEDIA UPLOAD:", { code: storageError.statusCode, message: storageError.message });
        return res.status(500).json({ error: "Status media upload failed. Run supabase-feature-pack.sql and verify Render's Supabase project/key." });
      }
      uploadedPath = pathName;
    }
    const createdAt = new Date();
    const insertRow = {
      user_id: userId, content: content || null, media_path: uploadedPath,
      media_type: media ? media.mimetype : "text",
      created_at: createdAt.toISOString(), expires_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
    };
    const { data, error } = await supabase.from("user_statuses").insert(insertRow).select("id,user_id,content,media_path,media_type,created_at,expires_at").single();
    if (error) {
      if (uploadedPath) await supabase.storage.from("status-media").remove([uploadedPath]);
      console.error("STATUS SAVE:", { code: error.code, message: error.message, hint: error.hint });
      return res.status(503).json({ error: isMissingFeatureTable(error, "user_statuses") ? "Run supabase-feature-pack.sql in Supabase before posting statuses." : "Could not save status. Check Render logs for STATUS SAVE." });
    }
    io.emit("status-created", { userId });
    res.status(201).json({ success: true, status: data });
  } catch (error) {
    if (uploadedPath) { try { await supabase.storage.from("status-media").remove([uploadedPath]); } catch (_) {} }
    console.error("STATUS CREATE ERROR:", { code: error.code, message: error.message });
    res.status(500).json({ error: "Could not post status. Check Supabase Storage and feature migration." });
  }
});

app.post("/api/statuses/:statusId/view", authMiddleware, async (req, res) => {
  try {
    const statusId = Number(req.params.statusId), viewerId = Number(req.user.id);
    if (!Number.isInteger(statusId) || statusId < 1) return res.status(400).json({ error: "Invalid status." });
    const { data: status, error: statusError } = await supabase.from("user_statuses").select("id,user_id,expires_at").eq("id", statusId).gt("expires_at", new Date().toISOString()).maybeSingle();
    if (statusError) return res.status(503).json({ error: "Status feature is not ready. Run supabase-feature-pack.sql." });
    if (!status) return res.status(404).json({ error: "This status has expired or been removed." });
    if (Number(status.user_id) !== viewerId) {
      const { data: friendship, error: friendshipError } = await supabase.from("friendships").select("id").eq("user_id", viewerId).eq("friend_id", Number(status.user_id)).maybeSingle();
      if (friendshipError || !friendship) return res.status(403).json({ error: "Only friends can view this status." });
      const { error: viewError } = await supabase.from("status_views").upsert({ status_id: statusId, viewer_id: viewerId, viewed_at: new Date().toISOString() }, { onConflict: "status_id,viewer_id", ignoreDuplicates: true });
      if (viewError) return res.status(500).json({ error: "Could not save status view." });
      const ownerSocket = onlineUsers.get(String(status.user_id));
      if (ownerSocket) io.to(ownerSocket.socketId).emit("status-viewed", { statusId, viewerId });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("STATUS VIEW:", { code: error.code, message: error.message });
    res.status(500).json({ error: "Could not record status view." });
  }
});

app.delete("/api/statuses/:statusId", authMiddleware, async (req, res) => {
  try {
    const statusId = Number(req.params.statusId), userId = Number(req.user.id);
    const { data: status, error: lookupError } = await supabase.from("user_statuses").select("id,user_id,media_path").eq("id", statusId).maybeSingle();
    if (lookupError) return res.status(503).json({ error: "Status feature is not ready. Run supabase-feature-pack.sql." });
    if (!status) return res.status(404).json({ error: "Status not found." });
    if (Number(status.user_id) !== userId) return res.status(403).json({ error: "You can delete only your own status." });
    if (status.media_path) {
      const { error: storageError } = await supabase.storage.from("status-media").remove([status.media_path]);
      if (storageError) return res.status(500).json({ error: "Could not remove status media. Please retry." });
    }
    const { error } = await supabase.from("user_statuses").delete().eq("id", statusId).eq("user_id", userId);
    if (error) return res.status(500).json({ error: "Could not delete status." });
    await supabase.from("status_views").delete().eq("status_id", statusId);
    io.emit("status-created", { userId });
    res.json({ success: true });
  } catch (error) {
    console.error("STATUS DELETE:", { code: error.code, message: error.message });
    res.status(500).json({ error: "Could not delete status." });
  }
});

/* =========================================================
   BLOCK, UNBLOCK, REPORT
========================================================= */
app.get("/api/blocks", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const { data: rows, error } = await supabase.from("user_blocks").select("blocked_id,created_at").eq("blocker_id", userId).order("created_at", { ascending: false });
    if (error) return res.status(503).json({ error: "Run supabase-feature-pack.sql to enable block settings." });
    const ids = (rows || []).map(row => Number(row.blocked_id));
    if (!ids.length) return res.json([]);
    const { data: users, error: userError } = await supabase.from("users").select("id,username,avatar_url").in("id", ids);
    if (userError) return res.status(500).json({ error: "Could not load blocked users." });
    const byId = new Map((users || []).map(user => [Number(user.id), user]));
    res.json(rows.map(row => ({ ...row, user: byId.get(Number(row.blocked_id)) || { id: row.blocked_id, username: `User ${row.blocked_id}` } })));
  } catch (error) { console.error("BLOCK LIST:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not load blocked users." }); }
});

app.post("/api/blocks", authMiddleware, async (req, res) => {
  try {
    const blockerId = Number(req.user.id), blockedId = Number(req.body.blockedUserId);
    if (!Number.isInteger(blockedId) || blockedId < 1 || blockedId === blockerId) return res.status(400).json({ error: "Choose a valid user to block." });
    const { data: target, error: targetError } = await supabase.from("users").select("id").eq("id", blockedId).maybeSingle();
    if (targetError) return res.status(500).json({ error: "Could not verify this user." });
    if (!target) return res.status(404).json({ error: "User not found." });
    const { error } = await supabase.from("user_blocks").upsert({ blocker_id: blockerId, blocked_id: blockedId }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true });
    if (error) return res.status(503).json({ error: isMissingFeatureTable(error, "user_blocks") ? "Run supabase-feature-pack.sql to enable blocking." : "Could not block this user." });
    await supabase.from("friendships").delete().or(`and(user_id.eq.${blockerId},friend_id.eq.${blockedId}),and(user_id.eq.${blockedId},friend_id.eq.${blockerId})`);
    await supabase.from("friend_requests").delete().or(`and(sender_id.eq.${blockerId},receiver_id.eq.${blockedId}),and(sender_id.eq.${blockedId},receiver_id.eq.${blockerId})`);
    const targetSocket = onlineUsers.get(String(blockedId));
    if (targetSocket) io.to(targetSocket.socketId).emit("contact-blocked", { userId: blockerId });
    res.json({ success: true });
  } catch (error) { console.error("BLOCK USER:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not block this user." }); }
});

app.delete("/api/blocks/:blockedUserId", authMiddleware, async (req, res) => {
  try {
    const blockerId = Number(req.user.id), blockedId = Number(req.params.blockedUserId);
    const { error } = await supabase.from("user_blocks").delete().eq("blocker_id", blockerId).eq("blocked_id", blockedId);
    if (error) return res.status(503).json({ error: "Could not update block settings. Check the feature migration." });
    res.json({ success: true });
  } catch (error) { console.error("UNBLOCK USER:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not unblock this user." }); }
});

app.post("/api/reports", authMiddleware, async (req, res) => {
  try {
    const reporterId = Number(req.user.id), reportedUserId = Number(req.body.reportedUserId);
    const allowedReasons = new Set(["spam", "harassment", "impersonation", "inappropriate-content", "other"]);
    const reason = String(req.body.reason || "other").trim().toLowerCase();
    const details = String(req.body.details || "").trim().slice(0, 1000);
    if (!Number.isInteger(reportedUserId) || reportedUserId < 1 || reportedUserId === reporterId) return res.status(400).json({ error: "Choose a valid user to report." });
    if (!allowedReasons.has(reason)) return res.status(400).json({ error: "Choose a valid report reason." });
    const { data: target, error: targetError } = await supabase.from("users").select("id").eq("id", reportedUserId).maybeSingle();
    if (targetError || !target) return res.status(404).json({ error: "Reported user was not found." });
    const { error } = await supabase.from("user_reports").insert({ reporter_id: reporterId, reported_user_id: reportedUserId, reason, details: details || null, status: "open" });
    if (error) return res.status(503).json({ error: isMissingFeatureTable(error, "user_reports") ? "Run supabase-feature-pack.sql to enable reports." : "Could not submit report." });
    res.status(201).json({ success: true, message: "Report sent for review." });
  } catch (error) { console.error("REPORT USER:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not submit report." }); }
});

/* =========================================================
   PINNED MESSAGES AND FORWARDING
========================================================= */
app.get("/api/pins/:otherUserId", authMiddleware, async (req, res) => {
  try {
    const userId = Number(req.user.id), otherId = Number(req.params.otherUserId);
    if (!Number.isInteger(otherId) || otherId < 1 || otherId === userId) return res.status(400).json({ error: "Invalid conversation." });
    const { data: pins, error } = await supabase.from("pinned_messages").select("message_id").eq("user_id", userId).order("created_at", { ascending: false }).limit(200);
    if (error) return res.status(503).json({ error: "Run supabase-feature-pack.sql to enable pinned messages." });
    const ids = (pins || []).map(pin => Number(pin.message_id));
    if (!ids.length) return res.json([]);
    const { data: messages, error: messageError } = await supabase.from("messages").select("id,sender_id,receiver_id").in("id", ids);
    if (messageError) return res.status(500).json({ error: "Could not load pinned messages." });
    res.json((messages || []).filter(message => {
      const a = Number(message.sender_id), b = Number(message.receiver_id);
      return (a === userId && b === otherId) || (a === otherId && b === userId);
    }).map(message => Number(message.id)));
  } catch (error) { console.error("LOAD PINS:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not load pinned messages." }); }
});

app.post("/api/messages/:messageId/pin", authMiddleware, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId), userId = Number(req.user.id);
    const { data: message, error: readError } = await supabase.from("messages").select("id,sender_id,receiver_id,is_deleted").eq("id", messageId).maybeSingle();
    if (readError || !message) return res.status(404).json({ error: "Message not found." });
    if (Number(message.sender_id) !== userId && Number(message.receiver_id) !== userId) return res.status(403).json({ error: "You cannot pin this message." });
    if (message.is_deleted) return res.status(400).json({ error: "Deleted messages cannot be pinned." });
    const { count, error: countError } = await supabase.from("pinned_messages").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if (countError && !isMissingFeatureTable(countError, "pinned_messages")) return res.status(500).json({ error: "Could not check pinned messages." });
    if ((count || 0) >= 200) return res.status(409).json({ error: "You can keep up to 200 pinned messages. Unpin one first." });
    const { error } = await supabase.from("pinned_messages").upsert({ user_id: userId, message_id: messageId }, { onConflict: "user_id,message_id", ignoreDuplicates: true });
    if (error) return res.status(503).json({ error: "Run supabase-feature-pack.sql to enable pinned messages." });
    res.json({ success: true, pinned: true });
  } catch (error) { console.error("PIN MESSAGE:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not pin message." }); }
});

app.delete("/api/messages/:messageId/pin", authMiddleware, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId), userId = Number(req.user.id);
    const { error } = await supabase.from("pinned_messages").delete().eq("user_id", userId).eq("message_id", messageId);
    if (error) return res.status(503).json({ error: "Could not update pinned messages. Run the feature SQL migration." });
    res.json({ success: true, pinned: false });
  } catch (error) { res.status(500).json({ error: "Could not unpin message." }); }
});

app.post("/api/messages/:messageId/forward", authMiddleware, async (req, res) => {
  try {
    const messageId = Number(req.params.messageId), senderId = Number(req.user.id), receiverId = Number(req.body.receiverId);
    if (!Number.isInteger(receiverId) || receiverId < 1 || receiverId === senderId) return res.status(400).json({ error: "Choose a valid friend user ID." });
    const { data: original, error: readError } = await supabase.from("messages").select("*").eq("id", messageId).maybeSingle();
    if (readError || !original) return res.status(404).json({ error: "Original message not found." });
    if (Number(original.sender_id) !== senderId && Number(original.receiver_id) !== senderId) return res.status(403).json({ error: "You cannot forward this message." });
    if (original.is_deleted) return res.status(400).json({ error: "Deleted messages cannot be forwarded." });
    const { data: receiver, error: receiverError } = await supabase.from("users").select("id").eq("id", receiverId).maybeSingle();
    if (receiverError || !receiver) return res.status(404).json({ error: "Recipient not found." });
    if (await areUsersBlocked(senderId, receiverId)) return res.status(403).json({ error: "This recipient is blocked." });
    const forwarded = {
      sender_id: senderId, receiver_id: receiverId,
      message: original.message_type === "file" ? (original.message || `Forwarded: ${original.file_name || "file"}`) : original.message,
      message_type: original.message_type || "text", file_name: original.file_name || null,
      file_url: original.file_url || null, file_size: original.file_size || null,
      is_read: false, is_deleted: false, is_edited: false, is_forwarded: true,
      forwarded_from: messageId
    };
    const { data: saved, error } = await supabase.from("messages").insert(forwarded).select("*").single();
    if (error) {
      console.error("FORWARD MESSAGE:", { code: error.code, message: error.message });
      return res.status(500).json({ error: "Could not forward message. Run the feature SQL migration." });
    }
    const receiverSocket = onlineUsers.get(String(receiverId));
    if (receiverSocket) io.to(receiverSocket.socketId).emit("private-message", saved);
    const senderSocket = onlineUsers.get(String(senderId));
    if (senderSocket) io.to(senderSocket.socketId).emit("private-message", saved);
    res.status(201).json({ success: true, message: saved });
  } catch (error) { console.error("FORWARD MESSAGE ERROR:", { code: error.code, message: error.message }); res.status(500).json({ error: "Could not forward message." }); }
});

/* =========================================================
   PERMANENT ACCOUNT DELETION
   Re-authenticates with the current password, removes the user's
   direct-message data and relationships, cleans owned storage files,
   and transfers groups to another member where possible.
========================================================= */
app.delete("/api/account", authMiddleware, async (req, res) => {
  const userId = Number(req.user && req.user.id);
  const password = String((req.body && req.body.password) || "");

  if (!Number.isInteger(userId) || userId < 1) {
    return res.status(401).json({ error: "Please log in again." });
  }
  if (!password) {
    return res.status(400).json({ error: "Enter your current password to confirm deletion." });
  }

  const ensureQuery = async (query, label) => {
    const result = await query;
    if (result.error) {
      console.error(`ACCOUNT DELETE ${label}:`, result.error);
      throw new Error(label);
    }
    return result.data;
  };

  const collectStorageFiles = async (bucketName, prefix) => {
    const files = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .list(prefix, { limit: pageSize, offset });
      if (error) {
        console.error("ACCOUNT DELETE STORAGE LIST:", error);
        throw new Error("Could not inspect uploaded files");
      }

      const entries = data || [];
      for (const entry of entries) {
        const fullPath = `${prefix}/${entry.name}`;
        // Storage folder entries have a null id; traverse them as well.
        if (entry.id == null) {
          files.push(...await collectStorageFiles(bucketName, fullPath));
        } else {
          files.push(fullPath);
        }
      }

      offset += entries.length;
      if (entries.length < pageSize) break;
    }
    return files;
  };

  const inBatches = async (items, batchSize, callback) => {
    for (let i = 0; i < items.length; i += batchSize) {
      await callback(items.slice(i, i + batchSize));
    }
  };

  try {
    // Verify the authenticated account still exists and re-check its password.
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, username, password_hash")
      .eq("id", userId)
      .maybeSingle();

    if (userError) {
      console.error("ACCOUNT DELETE USER LOOKUP:", userError);
      return res.status(500).json({ error: "Could not verify your account. Please try again." });
    }
    if (!user) {
      return res.status(404).json({ error: "This account no longer exists. Please log out." });
    }

    const passwordValid = await bcrypt.compare(password, String(user.password_hash || ""));
    if (!passwordValid) {
      return res.status(401).json({ error: "The current password is incorrect." });
    }

    // Preflight the records that will be affected before performing deletions.
    const ownedGroups = await ensureQuery(
      supabase.from("groups").select("id").eq("created_by", userId),
      "READ OWNED GROUPS"
    ) || [];
    const groupPlan = [];
    for (const group of ownedGroups) {
      const { data: otherMember, error: memberError } = await supabase
        .from("group_members")
        .select("user_id")
        .eq("group_id", group.id)
        .neq("user_id", userId)
        .order("user_id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (memberError) {
        console.error("ACCOUNT DELETE READ GROUP MEMBERS:", memberError);
        throw new Error("Could not check group ownership");
      }
      groupPlan.push({ groupId: group.id, transferTo: otherMember ? Number(otherMember.user_id) : null });
    }

    const privateMessageIds = [];
    const messagePageSize = 1000;
    let messageOffset = 0;
    while (true) {
      const { data: page, error: messageLookupError } = await supabase
        .from("messages")
        .select("id")
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
        .order("id", { ascending: true })
        .range(messageOffset, messageOffset + messagePageSize - 1);
      if (messageLookupError) {
        console.error("ACCOUNT DELETE READ MESSAGES:", messageLookupError);
        throw new Error("Could not inspect chat history");
      }
      const rows = page || [];
      privateMessageIds.push(...rows.map(row => row.id));
      messageOffset += rows.length;
      if (rows.length < messagePageSize) break;
    }

    const storedFiles = await collectStorageFiles("chat-files", String(userId));
    const storedAvatarFiles = await collectStorageFiles("profile-avatars", String(userId));
    // These feature tables are additive; keep account deletion compatible with older deployments
    // that have not run the feature migration yet.
    const { data: ownStatusesForCleanup, error: ownStatusesError } = await supabase.from("user_statuses").select("id").eq("user_id", userId);
    const statusFeatureTablesInstalled = !ownStatusesError || !isMissingFeatureTable(ownStatusesError, "user_statuses");
    if (ownStatusesError && !isMissingFeatureTable(ownStatusesError, "user_statuses")) {
      console.error("ACCOUNT DELETE READ STATUSES:", ownStatusesError);
      throw new Error("Could not inspect account statuses");
    }
    const ownStatusIds = (ownStatusesForCleanup || []).map(row => row.id);
    let storedStatusFiles = [];
    if (statusFeatureTablesInstalled) {
      const { data: statusBucket, error: statusBucketError } = await supabase.storage.getBucket("status-media");
      if (statusBucketError) {
        const msg = String(statusBucketError.message || "").toLowerCase();
        if (msg.includes("not found") || String(statusBucketError.statusCode || "") === "404") {
          console.warn("ACCOUNT DELETE: status-media bucket not installed; skipping optional status storage cleanup.");
        } else {
          console.error("ACCOUNT DELETE STATUS BUCKET:", { message: statusBucketError.message, statusCode: statusBucketError.statusCode });
          throw new Error("Could not inspect status media");
        }
      } else if (statusBucket) {
        storedStatusFiles = await collectStorageFiles("status-media", String(userId));
      }
    }

    // Delete this account's uploads and profile pictures. If Storage rejects
    // deletion, stop before modifying database records so a retry remains possible.
    await inBatches(storedFiles, 100, async paths => {
      const { error } = await supabase.storage.from("chat-files").remove(paths);
      if (error) {
        console.error("ACCOUNT DELETE CHAT FILES REMOVE:", error);
        throw new Error("Could not remove all uploaded files");
      }
    });
    await inBatches(storedAvatarFiles, 100, async paths => {
      const { error } = await supabase.storage.from("profile-avatars").remove(paths);
      if (error) {
        console.error("ACCOUNT DELETE PROFILE AVATARS REMOVE:", error);
        throw new Error("Could not remove profile pictures");
      }
    });
    await inBatches(storedStatusFiles, 100, async paths => {
      const { error } = await supabase.storage.from("status-media").remove(paths);
      if (error) {
        console.error("ACCOUNT DELETE STATUS MEDIA REMOVE:", error);
        throw new Error("Could not remove status media");
      }
    });

    // Remove per-account features before message/user rows. Optional tables may be absent on an older deploy.
    const ensureOptionalQuery = async (query, label, tableName) => {
      const result = await query;
      if (result.error && isMissingFeatureTable(result.error, tableName)) {
        console.warn(`ACCOUNT DELETE: optional table ${tableName} is not installed; skipping ${label}.`);
        return null;
      }
      if (result.error) {
        console.error(`ACCOUNT DELETE ${label}:`, result.error);
        throw new Error(label);
      }
      return result.data;
    };
    if (statusFeatureTablesInstalled) {
      await ensureOptionalQuery(supabase.from("user_statuses").delete().eq("user_id", userId), "DELETE STATUSES", "user_statuses");
      await ensureOptionalQuery(supabase.from("status_views").delete().eq("viewer_id", userId), "DELETE STATUS VIEWS BY USER", "status_views");
      if (ownStatusIds.length) await ensureOptionalQuery(supabase.from("status_views").delete().in("status_id", ownStatusIds), "DELETE VIEWS FOR OWN STATUSES", "status_views");
    }
    await ensureOptionalQuery(supabase.from("user_blocks").delete().or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`), "DELETE BLOCKS", "user_blocks");
    await ensureOptionalQuery(supabase.from("pinned_messages").delete().eq("user_id", userId), "DELETE PINNED MESSAGES", "pinned_messages");
    if (privateMessageIds.length) await ensureOptionalQuery(supabase.from("pinned_messages").delete().in("message_id", privateMessageIds), "DELETE PINS FOR ACCOUNT MESSAGES", "pinned_messages");

    // Remove reactions before deleting any message rows they refer to.
    await ensureQuery(
      supabase.from("message_reactions").delete().eq("user_id", userId),
      "DELETE OWN REACTIONS"
    );
    await inBatches(privateMessageIds, 200, async ids => {
      await ensureQuery(
        supabase.from("message_reactions").delete().in("message_id", ids),
        "DELETE REACTIONS FOR ACCOUNT CHATS"
      );
    });
    await inBatches(privateMessageIds, 200, async ids => {
      await ensureQuery(
        supabase.from("messages").delete().in("id", ids),
        "DELETE PRIVATE MESSAGES"
      );
    });

    // Remove authored group messages. Keep other members' messages intact
    // when a group can be transferred to another member.
    await ensureQuery(
      supabase.from("group_messages").delete().eq("sender_id", userId),
      "DELETE OWN GROUP MESSAGES"
    );

    for (const plan of groupPlan) {
      if (plan.transferTo) {
        await ensureQuery(
          supabase.from("groups").update({ created_by: plan.transferTo }).eq("id", plan.groupId),
          "TRANSFER GROUP OWNERSHIP"
        );
      } else {
        await ensureQuery(
          supabase.from("group_messages").delete().eq("group_id", plan.groupId),
          "DELETE EMPTY OWNED GROUP MESSAGES"
        );
        await ensureQuery(
          supabase.from("group_members").delete().eq("group_id", plan.groupId),
          "DELETE EMPTY OWNED GROUP MEMBERS"
        );
        await ensureQuery(
          supabase.from("groups").delete().eq("id", plan.groupId),
          "DELETE EMPTY OWNED GROUP"
        );
      }
    }

    await ensureQuery(
      supabase.from("friend_requests").delete().or(`sender_id.eq.${userId},receiver_id.eq.${userId}`),
      "DELETE FRIEND REQUESTS"
    );
    await ensureQuery(
      supabase.from("friendships").delete().eq("user_id", userId),
      "DELETE OUTGOING FRIENDSHIPS"
    );
    await ensureQuery(
      supabase.from("friendships").delete().eq("friend_id", userId),
      "DELETE INCOMING FRIENDSHIPS"
    );
    await ensureQuery(
      supabase.from("group_members").delete().eq("user_id", userId),
      "DELETE GROUP MEMBERSHIPS"
    );

    // Remove optional monetization records if its migration has been installed.
    // Missing optional tables should not prevent account deletion on an older deployment.
    for (const [table, label] of [["premium_purchases", "ACCOUNT DELETE PREMIUM PURCHASES"], ["user_premium", "ACCOUNT DELETE PREMIUM STATUS"]]) {
      const { error } = await supabase.from(table).delete().eq("user_id", userId);
      if (error && !missingBillingTable(error)) {
        console.error(`${label}:`, { code: error.code, message: error.message });
        throw new Error("Could not remove billing records");
      }
    }

    // Keep the users row until all known dependent records are cleaned up.
    await ensureQuery(
      supabase.from("users").delete().eq("id", userId),
      "DELETE ACCOUNT RECORD"
    );

    onlineUsers.delete(String(userId));
    io.emit("account-deleted", { userId });
    for (const activeSocket of io.sockets.sockets.values()) {
      if (String(activeSocket.userId) === String(userId)) {
        // Let the event reach other tabs before closing their sockets.
        setTimeout(() => {
          const stillConnected = io.sockets.sockets.get(activeSocket.id);
          if (stillConnected) stillConnected.disconnect(true);
        }, 150);
      }
    }
    io.emit("online-users", Array.from(onlineUsers.keys()));

    return res.json({
      success: true,
      message: "Your account and associated app data have been permanently deleted."
    });
  } catch (error) {
    console.error("ACCOUNT DELETE ERROR:", error);
    return res.status(500).json({
      error: "The account could not be completely deleted. Please try again. If the problem continues, contact support."
    });
  }
});

/* =========================================================
   USERS
========================================================= */

app.get(
  "/api/users",
  authMiddleware,
  async (req, res) => {

    try {

      const search =
        String(
          req.query.search || ""
        )
          .trim()
          .toLowerCase();

      let query =
        supabase
          .from("users")
          .select(
            "id, username, avatar_url, last_seen, created_at"
          )
          .neq(
            "id",
            req.user.id
          )
          .order(
            "username",
            {
              ascending: true
            }
          )
          .limit(100);

      if (search) {

        query =
          query.ilike(
            "username",
            `%${search}%`
          );
      }

      const {
        data,
        error
      } = await query;

      if (error) {

        console.error(
          "USERS:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load users"
        });
      }

      let visibleUsers = data || [];
      const { data: blockRows, error: blockError } = await supabase.from("user_blocks")
        .select("blocker_id,blocked_id")
        .or(`blocker_id.eq.${Number(req.user.id)},blocked_id.eq.${Number(req.user.id)}`);
      if (!blockError) {
        const hiddenIds = new Set((blockRows || []).map(row => Number(Number(row.blocker_id) === Number(req.user.id) ? row.blocked_id : row.blocker_id)));
        visibleUsers = visibleUsers.filter(user => !hiddenIds.has(Number(user.id)));
      } else if (!isMissingFeatureTable(blockError, "user_blocks")) {
        console.error("USERS BLOCK FILTER:", { code: blockError.code, message: blockError.message });
      }

      const users = visibleUsers.map(user => ({
        ...user,
        online: onlineUsers.has(String(user.id))
      }));

      res.json(users);

    } catch (error) {

      console.error(
        "USERS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "User search failed"
      });
    }
  }
);

/* =========================================================
   FRIENDS
========================================================= */

app.post("/api/friends/request", authMiddleware, async (req,res)=>{
  try{
    const receiverId=Number(req.body.receiverId);
    const senderId=Number(req.user.id);
    if(!Number.isInteger(receiverId) || receiverId<=0 || receiverId===senderId)
      return res.status(400).json({error:"Invalid receiver"});

    const {data:receiver,error:receiverError}=await supabase.from("users").select("id,username").eq("id",receiverId).maybeSingle();
    if(receiverError) return res.status(500).json({error:"Database error"});
    if(!receiver) return res.status(404).json({error:"User not found"});

    try {
      if (await areUsersBlocked(senderId, receiverId)) return res.status(403).json({ error: "This connection is blocked. Unblock the user before sending a request." });
    } catch (blockError) {
      console.error("FRIEND REQUEST BLOCK CHECK:", { code: blockError.code, message: blockError.message });
      return res.status(503).json({ error: "Could not verify block settings. Run supabase-feature-pack.sql and try again." });
    }

    const {data:existingFriend}=await supabase.from("friendships").select("id").eq("user_id",senderId).eq("friend_id",receiverId).maybeSingle();
    if(existingFriend) return res.status(409).json({error:"Already friends"});

    const {data:reverseFriend}=await supabase.from("friendships").select("id").eq("user_id",receiverId).eq("friend_id",senderId).maybeSingle();
    if(reverseFriend) return res.status(409).json({error:"Already friends"});

    const {data:existing}=await supabase.from("friend_requests").select("id,sender_id,receiver_id,status").or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`).in("status",["pending"]).maybeSingle();
    if(existing) return res.status(409).json({error:"Friend request already pending"});

    const {data:request,error}=await supabase.from("friend_requests").insert({sender_id:senderId,receiver_id:receiverId,status:"pending"}).select("*").single();
    if(error) return res.status(500).json({error:"Could not send friend request"});

    const notifyReceiver=onlineUsers.get(String(receiverId));
    if(notifyReceiver) io.to(notifyReceiver.socketId).emit("friend-request",request);
    res.status(201).json(request);
  }catch(error){ console.error("FRIEND REQUEST:",error); res.status(500).json({error:"Friend request failed"}); }
});

app.get("/api/friends/requests", authMiddleware, async (req,res)=>{
  try{
    const {data:requests,error}=await supabase.from("friend_requests").select("*").eq("receiver_id",Number(req.user.id)).eq("status","pending").order("created_at",{ascending:false});
    if(error) return res.status(500).json({error:"Could not load requests"});
    const ids=[...(requests||[]).map(r=>r.sender_id)];
    let users=[];
    if(ids.length){ const q=await supabase.from("users").select("id,username,avatar_url,last_seen").in("id",ids); users=q.data||[]; }
    const map=new Map(users.map(u=>[Number(u.id),u]));
    res.json((requests||[]).map(r=>({...r,sender:map.get(Number(r.sender_id))||null})));
  }catch(error){ console.error("REQUESTS:",error); res.status(500).json({error:"Could not load requests"}); }
});

app.post("/api/friends/respond", authMiddleware, async (req,res)=>{
  try{
    const requestId=Number(req.body.requestId);
    const action=String(req.body.action||"").toLowerCase();
    if(!Number.isInteger(requestId) || !["accept","reject"].includes(action)) return res.status(400).json({error:"Invalid request"});

    const {data:request,error}=await supabase.from("friend_requests").select("*").eq("id",requestId).eq("receiver_id",Number(req.user.id)).eq("status","pending").maybeSingle();
    if(error) return res.status(500).json({error:"Database error"});
    if(!request) return res.status(404).json({error:"Request not found"});

    const newStatus=action==="accept"?"accepted":"rejected";
    const {error:updateError}=await supabase.from("friend_requests").update({status:newStatus}).eq("id",requestId);
    if(updateError) return res.status(500).json({error:"Could not update request"});

    if(action==="accept"){
      const rows=[{user_id:Number(req.user.id),friend_id:Number(request.sender_id),status:"accepted"},{user_id:Number(request.sender_id),friend_id:Number(req.user.id),status:"accepted"}];
      const {error:friendError}=await supabase.from("friendships").upsert(rows,{onConflict:"user_id,friend_id",ignoreDuplicates:true});
      if(friendError) return res.status(500).json({error:"Could not create friendship"});
      const sender=onlineUsers.get(String(request.sender_id));
      if(sender) io.to(sender.socketId).emit("friend-accepted",{userId:Number(req.user.id)});
    } else {
      const sender=onlineUsers.get(String(request.sender_id));
      if(sender) io.to(sender.socketId).emit("friend-request-rejected",{userId:Number(req.user.id)});
    }
    res.json({success:true,status:newStatus});
  }catch(error){ console.error("FRIEND RESPOND:",error); res.status(500).json({error:"Request update failed"}); }
});

app.get("/api/friends", authMiddleware, async (req,res)=>{
  try{
    const {data:rows,error}=await supabase.from("friendships").select("friend_id").eq("user_id",Number(req.user.id));
    if(error) return res.status(500).json({error:"Could not load friends"});
    const ids=(rows||[]).map(r=>Number(r.friend_id));
    if(!ids.length) return res.json([]);
    const {data:users,error:userError}=await supabase.from("users").select("id,username,avatar_url,last_seen,created_at").in("id",ids).order("username",{ascending:true});
    if(userError) return res.status(500).json({error:"Could not load friends"});
    res.json((users||[]).map(u=>({...u,online:onlineUsers.has(String(u.id))})));
  }catch(error){ console.error("FRIENDS:",error); res.status(500).json({error:"Could not load friends"}); }
});

app.delete("/api/friends/:friendId", authMiddleware, async (req,res)=>{
  try{
    const friendId=Number(req.params.friendId), userId=Number(req.user.id);
    if(!Number.isInteger(friendId) || friendId===userId) return res.status(400).json({error:"Invalid friend"});
    await supabase.from("friendships").delete().eq("user_id",userId).eq("friend_id",friendId);
    await supabase.from("friendships").delete().eq("user_id",friendId).eq("friend_id",userId);
    const receiver=onlineUsers.get(String(friendId));
    if(receiver) io.to(receiver.socketId).emit("friend-removed",{userId});
    res.json({success:true});
  }catch(error){ console.error("REMOVE FRIEND:",error); res.status(500).json({error:"Could not remove friend"}); }
});

/* =========================================================
   MESSAGE SEARCH
========================================================= */
app.get("/api/messages/search", authMiddleware, async (req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const otherId=Number(req.query.userId);
    const me=Number(req.user.id);
    if(!q || !Number.isInteger(otherId)) return res.json([]);
    const {data,error}=await supabase.from("messages").select("*").or(`and(sender_id.eq.${me},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${me})`).ilike("message",`%${q}%`).eq("is_deleted",false).order("created_at",{ascending:false}).limit(100);
    if(error) return res.status(500).json({error:"Search failed"});
    res.json(data||[]);
  }catch(error){ console.error("MESSAGE SEARCH:",error); res.status(500).json({error:"Search failed"}); }
});

/* =========================================================
   REACTIONS
========================================================= */
app.get("/api/messages/:messageId/reactions", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId);
    const {data,error}=await supabase.from("message_reactions").select("id,message_id,user_id,emoji").eq("message_id",messageId);
    if(error) return res.status(500).json({error:"Could not load reactions"});
    res.json(data||[]);
  }catch(error){ res.status(500).json({error:"Could not load reactions"}); }
});

app.post("/api/messages/:messageId/reactions", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId), emoji=String(req.body.emoji||"").trim();
    if(!Number.isInteger(messageId)||!emoji||emoji.length>16) return res.status(400).json({error:"Invalid reaction"});
    const {data,error}=await supabase.from("message_reactions").upsert({message_id:messageId,user_id:Number(req.user.id),emoji},{onConflict:"message_id,user_id,emoji"}).select("*").single();
    if(error) return res.status(500).json({error:"Could not add reaction"});
    const {data:message}=await supabase.from("messages").select("sender_id,receiver_id").eq("id",messageId).maybeSingle();
    if(message){ for(const id of [message.sender_id,message.receiver_id]){ const u=onlineUsers.get(String(id)); if(u) io.to(u.socketId).emit("reaction-updated",{messageId}); } }
    res.json(data);
  }catch(error){ console.error("REACTION ADD:",error); res.status(500).json({error:"Reaction failed"}); }
});

app.delete("/api/messages/:messageId/reactions/:emoji", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId), emoji=String(req.params.emoji||"");
    await supabase.from("message_reactions").delete().eq("message_id",messageId).eq("user_id",Number(req.user.id)).eq("emoji",emoji);
    res.json({success:true});
  }catch(error){ res.status(500).json({error:"Could not remove reaction"}); }
});

/* =========================================================
   GROUPS
========================================================= */
app.get("/api/groups", authMiddleware, async (req,res)=>{
  try{
    const {data:members,error}=await supabase.from("group_members").select("group_id").eq("user_id",Number(req.user.id));
    if(error) return res.status(500).json({error:"Could not load groups"});
    const ids=(members||[]).map(m=>m.group_id); if(!ids.length) return res.json([]);
    const {data:groups,error:groupError}=await supabase.from("groups").select("*").in("id",ids).order("created_at",{ascending:false});
    if(groupError) return res.status(500).json({error:"Could not load groups"});
    res.json(groups||[]);
  }catch(error){res.status(500).json({error:"Could not load groups"});}
});

app.post("/api/groups", authMiddleware, async (req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name || name.length>80) return res.status(400).json({error:"Enter a valid group name"});
    const creatorId=Number(req.user.id);
    const {data:group,error}=await supabase.from("groups").insert({name,created_by:creatorId}).select("*").single();
    if(error) return res.status(500).json({error:"Could not create group"});
    const {error:memberError}=await supabase.from("group_members").insert({group_id:group.id,user_id:creatorId});
    if(memberError) return res.status(500).json({error:"Could not add creator"});
    res.status(201).json(group);
  }catch(error){res.status(500).json({error:"Group creation failed"});}
});

app.post("/api/groups/:groupId/members", authMiddleware, async (req,res)=>{
  try{
    const groupId=Number(req.params.groupId), userId=Number(req.body.userId), me=Number(req.user.id);
    if(!Number.isInteger(groupId)||!Number.isInteger(userId)) return res.status(400).json({error:"Invalid group/member"});
    const {data:creator}=await supabase.from("groups").select("created_by").eq("id",groupId).maybeSingle();
    if(!creator || Number(creator.created_by)!==me) return res.status(403).json({error:"Only group creator can add members"});
    const {error}=await supabase.from("group_members").upsert({group_id:groupId,user_id:userId},{onConflict:"group_id,user_id",ignoreDuplicates:true});
    if(error) return res.status(500).json({error:"Could not add member"});
    res.json({success:true});
  }catch(error){res.status(500).json({error:"Could not add member"});}
});

app.get("/api/groups/:groupId/messages", authMiddleware, async (req,res)=>{
  try{
    const groupId=Number(req.params.groupId), userId=Number(req.user.id);
    const {data:member}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",userId).maybeSingle();
    if(!member) return res.status(403).json({error:"Not a group member"});
    const {data,error}=await supabase.from("group_messages").select("*").eq("group_id",groupId).order("created_at",{ascending:true}).limit(500);
    if(error) return res.status(500).json({error:"Could not load group history"});
    res.json(data||[]);
  }catch(error){res.status(500).json({error:"Group history failed"});}
});

app.get("/api/groups/:groupId/messages/search", authMiddleware, async (req,res)=>{
  try{
    const groupId=Number(req.params.groupId), userId=Number(req.user.id), q=String(req.query.q||"").trim().slice(0,120);
    if(!Number.isInteger(groupId)||groupId<1||!q) return res.status(400).json({error:"Enter a search term."});
    const {data:member,error:memberError}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",userId).maybeSingle();
    if(memberError) return res.status(500).json({error:"Could not verify group membership."});
    if(!member) return res.status(403).json({error:"Not a group member."});
    const {data,error}=await supabase.from("group_messages").select("*").eq("group_id",groupId).ilike("message",`%${q.replace(/[%_]/g,"\\$&")}%`).order("created_at",{ascending:true}).limit(200);
    if(error) return res.status(500).json({error:"Could not search group messages."});
    res.json(data||[]);
  }catch(error){console.error("GROUP MESSAGE SEARCH:",error);res.status(500).json({error:"Group search failed."});}
});

/* =========================================================
   CHAT HISTORY
========================================================= */

app.get(
  "/api/messages/:userId/:otherUserId",
  authMiddleware,
  async (req, res) => {

    try {

      const userId =
        Number(
          req.params.userId
        );

      const otherUserId =
        Number(
          req.params.otherUserId
        );

      if (
        userId !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error:
            "Access denied"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("messages")
        .select("*")
        .or(
          `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        )
        .limit(500);

      if (error) {

        console.error(
          "HISTORY:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load chat history"
        });
      }

      res.json(
        data || []
      );

    } catch (error) {

      console.error(
        "HISTORY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Chat history failed"
      });
    }
  }
);

/* =========================================================
   DELETE MESSAGE
========================================================= */

app.delete(
  "/api/messages/:id",
  authMiddleware,
  async (req, res) => {

    try {

      const messageId =
        Number(
          req.params.id
        );

      const {
        data: message,
        error
      } = await supabase
        .from("messages")
        .select(
          "id, sender_id"
        )
        .eq(
          "id",
          messageId
        )
        .single();

      if (
        error ||
        !message
      ) {
        return res.status(404).json({
          error:
            "Message not found"
        });
      }

      if (
        Number(
          message.sender_id
        ) !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error:
            "You can only delete your own messages"
        });
      }

      const {
        error: deleteError
      } = await supabase
        .from("messages")
        .update({
          is_deleted:
            true,
          message:
            null,
          file_name:
            null,
          file_url:
            null
        })
        .eq(
          "id",
          messageId
        );

      if (deleteError) {

        console.error(
          "DELETE:",
          deleteError
        );

        return res.status(500).json({
          error:
            "Could not delete message"
        });
      }

      io.emit(
        "message-deleted",
        {
          id:
            messageId
        }
      );

      res.json({
        success:
          true
      });

    } catch (error) {

      console.error(
        "DELETE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Delete failed"
      });
    }
  }
);

/* =========================================================
   FILE UPLOAD
========================================================= */

app.post(
  "/api/upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error:
            "No file selected"
        });
      }

      const safeName =
        req.file.originalname
          .replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

      const filePath =
        `${req.user.id}/${Date.now()}-${safeName}`;

      const {
        error
      } = await supabase.storage
        .from("chat-files")
        .upload(
          filePath,
          req.file.buffer,
          {
            contentType:
              req.file.mimetype,
            upsert:
              false
          }
        );

      if (error) {

        console.error(
          "STORAGE:",
          error
        );

        return res.status(500).json({
          error:
            "File upload failed. Check chat-files bucket."
        });
      }

      const {
        data
      } =
        supabase.storage
          .from("chat-files")
          .getPublicUrl(
            filePath
          );

      res.json({
        success:
          true,

        file: {
          name:
            req.file.originalname,

          size:
            req.file.size,

          type:
            req.file.mimetype,

          path:
            filePath,

          url:
            data.publicUrl
        }
      });

    } catch (error) {

      console.error(
        "UPLOAD ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Upload failed"
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  async (req, res) => {

    try {

      const {
        error
      } = await supabase
        .from("users")
        .select("id")
        .limit(1);

      res.json({
        status:
          "ok",

        database:
          error
            ? "error"
            : "connected",

        socket:
          "enabled",

        storage:
          "enabled",

        webrtc:
          "enabled"
      });

    } catch (error) {

      console.error(
        "HEALTH:",
        error
      );

      res.status(500).json({
        status:
          "error",

        database:
          "error",

        socket:
          "enabled",

        storage:
          "enabled",

        webrtc:
          "enabled"
      });
    }
  }
);

/* =========================================================
   ONLINE USERS
========================================================= */

const onlineUsers =
  new Map();

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  "connection",
  socket => {

    console.log(
      "Socket connected:",
      socket.id
    );

    /* =====================================================
       USER ONLINE
    ===================================================== */

    socket.on(
      "user-online",
      async () => {

        try {

          if (!socket.userId) {
            socket.disconnect(true);
            return;
          }

          const { data: account, error: accountError } = await supabase
            .from("users")
            .select("id, username")
            .eq("id", Number(socket.userId))
            .maybeSingle();

          if (accountError || !account) {
            if (accountError) console.error("SOCKET ACCOUNT CHECK:", accountError);
            socket.emit("account-deleted", { userId: Number(user.id) });
            socket.disconnect(true);
            return;
          }

          const userId = String(account.id);
          onlineUsers.set(userId, {
            socketId: socket.id,
            username: account.username
          });
          socket.userId = userId;
          socket.username = account.username;

          // Join every group the authenticated user belongs to so they can
          // receive group-message notifications even when another chat is open.
          const { data: memberships, error: membershipsError } = await supabase
            .from("group_members")
            .select("group_id")
            .eq("user_id", account.id);
          if (membershipsError) {
            console.error("GROUP ROOM JOIN LOOKUP:", membershipsError);
          } else {
            (memberships || []).forEach(membership => {
              if (membership && membership.group_id != null) socket.join(`group:${membership.group_id}`);
            });
          }

          await supabase
            .from("users")
            .update({ last_seen: new Date().toISOString() })
            .eq("id", account.id);

          io.emit(
            "online-users",
            Array.from(
              onlineUsers.keys()
            )
          );

          console.log(
            "ONLINE:",
            account.username
          );

        } catch (error) {

          console.error(
            "ONLINE ERROR:",
            error
          );
        }
      }
    );

    /* =====================================================
       PRIVATE MESSAGE
       IMPORTANT: THIS IS INSIDE io.on("connection")
    ===================================================== */

    socket.on(
      "private-message",
      async data => {

        try {

          const senderId =
            Number(
              data.senderId
            );

          const receiverId =
            Number(
              data.receiverId
            );

          if (
            !senderId ||
            !receiverId
          ) {
            return;
          }

          /* Security check */

          if (
            senderId !==
            Number(socket.userId)
          ) {
            console.log(
              "Unauthorized message attempt"
            );

            return;
          }

          try {
            if (await areUsersBlocked(senderId, receiverId)) {
              socket.emit("message-error", { error: "You cannot message this user because one of you has blocked the other." });
              return;
            }
          } catch (blockError) {
            console.error("MESSAGE BLOCK CHECK:", { code: blockError.code, message: blockError.message });
            socket.emit("message-error", { error: "Could not verify block settings. Check the Supabase feature migration." });
            return;
          }

          const messageType =
            data.messageType ===
            "file"
              ? "file"
              : "text";

          const message =
            String(
              data.message || ""
            ).trim();

          if (
            messageType ===
              "text" &&
            !message
          ) {
            return;
          }

          const insertData = {

            sender_id:
              senderId,

            receiver_id:
              receiverId,

            message:
              message ||
              null,

            message_type:
              messageType,

            file_name:
              data.fileName ||
              null,

            file_url:
              data.fileUrl ||
              null,

            file_size:
              data.fileSize
                ? Number(
                    data.fileSize
                  )
                : null,

            // Explicit values keep inserts compatible with schemas that
            // have the corresponding NOT NULL columns without defaults.
            is_read: false,
            is_deleted: false,
            is_edited: false
          };

          const {
            data: saved,
            error
          } = await supabase
            .from("messages")
            .insert(
              insertData
            )
            .select("*")
            .single();

          if (error) {
            // Keep detailed database information in server logs, never expose it verbatim to users.
            console.error("MESSAGE DB ERROR:", JSON.stringify({
              code: error.code || null,
              message: error.message || null,
              details: error.details || null,
              hint: error.hint || null
            }));

            let userMessage = "Message could not be saved. Please check the Supabase message-table setup and Render logs.";
            if (error.code === "42501") {
              userMessage = "Supabase permission denied. Run supabase-fix-message-save.sql and verify Render uses the server-side Supabase secret/service_role key.";
            } else if (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST200") {
              userMessage = "Supabase messages table is missing a required column. Run supabase-fix-message-save.sql in the Supabase SQL Editor.";
            } else if (["22P02", "23503", "23514", "42804"].includes(error.code)) {
              userMessage = "Supabase rejected the message because the table schema or message type does not match. Run supabase-fix-message-save.sql and retry.";
            }

            socket.emit("message-error", { error: userMessage });
            return;
          }

          /* Send to receiver */

          const receiver =
            onlineUsers.get(
              String(
                receiverId
              )
            );

          if (receiver) {

            io.to(
              receiver.socketId
            ).emit(
              "private-message",
              saved
            );
          }

          /* Send back to sender */

          socket.emit(
            "private-message",
            saved
          );

        } catch (error) {

          console.error(
            "PRIVATE MESSAGE ERROR:",
            error
          );

          socket.emit(
            "message-error",
            {
              error:
                "Message failed"
            }
          );
        }
      }
    );

    /* =====================================================
       TYPING
    ===================================================== */

    socket.on(
      "typing",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "typing",
          {
            senderId:
              socket.userId,

            typing:
              Boolean(
                data.typing
              )
          }
        );
      }
    );

    /* =====================================================
       READ RECEIPTS
    ===================================================== */

    socket.on(
      "messages-read",
      async data => {

        try {

          const senderId =
            Number(
              data.senderId
            );

          const receiverId =
            Number(
              socket.userId
            );

          await supabase
            .from("messages")
            .update({
              is_read:
                true
            })
            .eq(
              "sender_id",
              senderId
            )
            .eq(
              "receiver_id",
              receiverId
            )
            .eq(
              "is_read",
              false
            );

          const sender =
            onlineUsers.get(
              String(
                senderId
              )
            );

          if (sender) {

            io.to(
              sender.socketId
            ).emit(
              "messages-read",
              {
                byUserId:
                  receiverId
              }
            );
          }

        } catch (error) {

          console.error(
            "READ ERROR:",
            error
          );
        }
      }
    );

    /* =====================================================
       START CALL
    ===================================================== */

    socket.on(
      "start-call",
      async data => {

        try {
          if (await areUsersBlocked(socket.userId, data && data.receiverId)) {
            socket.emit("call-error", { error: "You cannot call this user because one of you has blocked the other." });
            return;
          }
        } catch (blockError) {
          console.error("CALL BLOCK CHECK:", { code: blockError.code, message: blockError.message });
          socket.emit("call-error", { error: "Could not verify block settings. Please retry." });
          return;
        }

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {

          socket.emit(
            "call-error",
            {
              error:
                "User is offline"
            }
          );

          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "incoming-call",
          {
            ...data,

            callerSocketId:
              socket.id
          }
        );
      }
    );

    /* =====================================================
       CALL OFFER
    ===================================================== */

    socket.on(
      "call-offer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "call-offer",
          {
            ...data,

            callerSocketId:
              socket.id
          }
        );
      }
    );

    /* =====================================================
       CALL ANSWER
    ===================================================== */

    socket.on(
      "call-answer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "call-answer",
          data
        );
      }
    );

    /* =====================================================
       ICE CANDIDATE
    ===================================================== */

    socket.on(
      "ice-candidate",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "ice-candidate",
          data
        );
      }
    );

    /* =====================================================
       END CALL
    ===================================================== */

    socket.on(
      "end-call",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "end-call",
          data
        );
      }
    );

    /* =====================================================
       SCREEN SHARE
    ===================================================== */

    socket.on(
      "screen-share",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "screen-share",
          data
        );
      }
    );

    /* =====================================================
       CALL TRANSFER
    ===================================================== */

    socket.on(
      "call-transfer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.newReceiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "call-transfer",
          data
        );
      }
    );

    /* =====================================================
       GROUP CHAT
    ===================================================== */
    socket.on("join-group", async data=>{
      try{
        const groupId=Number(data.groupId), userId=Number(socket.userId);
        const {data:member}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",userId).maybeSingle();
        if(member) socket.join(`group:${groupId}`);
      }catch(error){ console.error("JOIN GROUP:",error); }
    });

    socket.on("group-message", async data=>{
      try{
        const groupId=Number(data.groupId), senderId=Number(socket.userId);
        if(!Number.isInteger(groupId)||groupId<1||!Number.isInteger(senderId)||senderId<1) return;
        const {data:member,error:memberError}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",senderId).maybeSingle();
        if(memberError || !member) return socket.emit("message-error",{error:"You are not a group member"});
        const messageType=data.messageType === "file" ? "file" : "text";
        const message=String(data.message||"").trim().slice(0,4000);
        const fileName=String(data.fileName||"").slice(0,255);
        const fileUrl=String(data.fileUrl||"").trim();
        const filePath=String(data.filePath||"").trim();
        const fileSize=Number(data.fileSize||0);
        if(messageType === "text" && !message) return;
        if(messageType === "file") {
          let parsedUrl, supabaseUrl;
          try { parsedUrl=new URL(fileUrl); supabaseUrl=new URL(SUPABASE_URL); } catch (_) { return socket.emit("message-error",{error:"Invalid uploaded file link."}); }
          const expectedPrefix=`${senderId}/`;
          const expectedPath=`/storage/v1/object/public/chat-files/${filePath}`;
          if(!filePath.startsWith(expectedPrefix) || filePath.split("/").includes("..") || parsedUrl.origin!==supabaseUrl.origin || parsedUrl.pathname!==expectedPath || !fileName || !Number.isFinite(fileSize) || fileSize<1 || fileSize>100*1024*1024) {
            return socket.emit("message-error",{error:"File details were invalid. Upload the file again."});
          }
        }
        const row={
          group_id:groupId, sender_id:senderId,
          message:message || (messageType === "file" ? `📎 ${fileName}` : null),
          message_type:messageType,
          file_name:messageType === "file" ? fileName : null,
          file_url:messageType === "file" ? fileUrl : null,
          file_size:messageType === "file" ? fileSize : null
        };
        const {data:saved,error}=await supabase.from("group_messages").insert(row).select("*").single();
        if(error) {
          console.error("GROUP MESSAGE DB ERROR:",{code:error.code,message:error.message});
          return socket.emit("message-error",{error:"Group message could not be saved. Run supabase-feature-pack.sql and check the group_messages columns."});
        }
        io.to(`group:${groupId}`).emit("group-message",saved);
      }catch(error){console.error("GROUP MESSAGE:", {code:error.code,message:error.message}); socket.emit("message-error",{error:"Group message failed."});}
    });

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      "disconnect",
      async () => {

        try {

          if (
            socket.userId
          ) {

            onlineUsers.delete(
              socket.userId
            );

            await supabase
              .from("users")
              .update({
                last_seen:
                  new Date().toISOString()
              })
              .eq(
                "id",
                Number(
                  socket.userId
                )
              );
          }

          io.emit(
            "online-users",
            Array.from(
              onlineUsers.keys()
            )
          );

          console.log(
            "Socket disconnected:",
            socket.id
          );

        } catch (error) {

          console.error(
            "DISCONNECT ERROR:",
            error
          );
        }
      }
    );
  }
);

/* =========================================================
   API FALLBACK + FRONTEND FALLBACK
   Unknown API paths should return JSON/404, never index.html/200. This also
   makes an old or mismatched backend deployment much easier to diagnose.
========================================================= */

app.use((req, res, next) => {
  if (req.path === "/api" || req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "API endpoint not found on this server release.",
      path: req.path,
      hint: "Deploy the matching latest server.js and confirm Render Root Directory and Start Command."
    });
  }
  next();
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.use(
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `RealTimeChat running on port ${PORT}`
    );
  }
);
