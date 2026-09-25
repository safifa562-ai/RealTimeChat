const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.disable("x-powered-by");

/* =========================
   DATABASE
========================= */

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      video_url TEXT NOT NULL,
      description TEXT DEFAULT '',
      thumbnail_url TEXT DEFAULT '',
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      site_name VARCHAR(100) DEFAULT 'MovieStream',
      ad_enabled BOOLEAN DEFAULT TRUE,
      ad_text TEXT DEFAULT 'Support MovieStream',
      sponsor_url TEXT DEFAULT ''
    );
  `);

  await pool.query(`
    INSERT INTO site_settings
      (id, site_name, ad_enabled, ad_text, sponsor_url)
    VALUES
      (1, 'MovieStream', TRUE, 'Support MovieStream', '')
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log("Database tables ready");
}

/* =========================
   AUTH
========================= */

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin,
      isPremium: user.is_premium
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Login required"
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired login"
    });
  }
}

function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({
      error: "Admin access required"
    });
  }

  next();
}

/* =========================
   REGISTER
========================= */

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({
        error: "Username must be 3-50 characters"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters"
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (username, password_hash)
      VALUES ($1, $2)
      RETURNING id, username, is_admin, is_premium
      `,
      [username, hash]
    );

    const user = result.rows[0];

    res.json({
      token: createToken(user),
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    res.json({
      token: createToken(user),
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Login failed"
    });
  }
});

/* =========================
   CURRENT USER
========================= */

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    `
    SELECT id, username, is_admin, is_premium
    FROM users
    WHERE id = $1
    `,
    [req.user.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  const user = result.rows[0];

  res.json({
    id: user.id,
    username: user.username,
    isAdmin: user.is_admin,
    isPremium: user.is_premium
  });
});

/* =========================
   MOVIES
========================= */

app.get("/api/movies", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        description,
        thumbnail_url,
        video_url,
        is_premium,
        created_at
      FROM movies
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not load movies"
    });
  }
});

/* =========================
   WATCH MOVIE
========================= */

app.get("/api/movies/:id/watch", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM movies WHERE id = $1",
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      error: "Movie not found"
    });
  }

  const movie = result.rows[0];

  if (movie.is_premium && !req.user.isPremium && !req.user.isAdmin) {
    return res.status(402).json({
      premium: true,
      error: "Premium membership required"
    });
  }

  res.json({
    id: movie.id,
    title: movie.title,
    videoUrl: movie.video_url
  });
});

/* =========================
   ADMIN: ADD MOVIE
========================= */

app.post("/api/admin/movies", auth, adminOnly, async (req, res) => {
  try {
    const {
      title,
      videoUrl,
      description = "",
      thumbnailUrl = "",
      isPremium = false
    } = req.body;

    if (!title || !videoUrl) {
      return res.status(400).json({
        error: "Title and video URL are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO movies
      (title, video_url, description, thumbnail_url, is_premium)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        title,
        videoUrl,
        description,
        thumbnailUrl,
        Boolean(isPremium)
      ]
    );

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Could not add movie"
    });
  }
});

/* =========================
   ADMIN: DELETE MOVIE
========================= */

app.delete("/api/admin/movies/:id", auth, adminOnly, async (req, res) => {
  await pool.query(
    "DELETE FROM movies WHERE id = $1",
    [req.params.id]
  );

  res.json({
    success: true
  });
});

/* =========================
   ADMIN: MAKE USER PREMIUM
========================= */

app.patch("/api/admin/users/:id/premium", auth, adminOnly, async (req, res) => {
  const enabled = Boolean(req.body.enabled);

  const result = await pool.query(
    `
    UPDATE users
    SET is_premium = $1
    WHERE id = $2
    RETURNING id, username, is_premium
    `,
    [enabled, req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({
      error: "User not found"
    });
  }

  res.json(result.rows[0]);
});

/* =========================
   ADS / SPONSOR SETTINGS
========================= */

app.get("/api/settings", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM site_settings WHERE id = 1"
  );

  res.json(result.rows[0]);
});

app.patch("/api/admin/settings", auth, adminOnly, async (req, res) => {
  const {
    siteName,
    adEnabled,
    adText,
    sponsorUrl
  } = req.body;

  const result = await pool.query(
    `
    UPDATE site_settings
    SET
      site_name = COALESCE($1, site_name),
      ad_enabled = COALESCE($2, ad_enabled),
      ad_text = COALESCE($3, ad_text),
      sponsor_url = COALESCE($4, sponsor_url)
    WHERE id = 1
    RETURNING *
    `,
    [
      siteName ?? null,
      adEnabled ?? null,
      adText ?? null,
      sponsorUrl ?? null
    ]
  );

  res.json(result.rows[0]);
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });
  } catch {
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

/* =========================
   FRONTEND
========================= */

app.use((req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});
/* =========================
   START
========================= */

async function startServer() {
  try {
    await createTables();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(`MovieStream running on port ${PORT}`);
    });

  } catch (error) {
    console.error("Database startup error:", error);
    process.exit(1);
  }
}

startServer();
