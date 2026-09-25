const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const helmet = require("helmet");

const app = express();

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
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ==================== DATABASE ====================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      thumbnail_url TEXT DEFAULT '',
      description TEXT DEFAULT '',
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id SERIAL PRIMARY KEY,
      site_name TEXT DEFAULT 'MovieStream',
      ad_text TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database tables ready");
}

// ==================== AUTH ====================

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      isAdmin: user.is_admin,
      isPremium: user.is_premium,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Please login first",
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Session expired. Please login again.",
    });
  }
}

async function adminOnly(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT is_admin FROM users WHERE id = $1",
      [req.user.id]
    );

    if (!result.rows.length || !result.rows[0].is_admin) {
      return res.status(403).json({
        error: "Admin access required",
      });
    }

    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Server error",
    });
  }
}

// ==================== REGISTER ====================

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required",
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        error: "Username must be at least 3 characters",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "Username already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users
       (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, is_admin, is_premium`,
      [username, passwordHash]
    );

    const user = result.rows[0];
    const token = createToken(user);

    res.status(201).json({
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium,
      },
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed",
    });
  }
});

// ==================== LOGIN ====================

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required",
      });
    }

    const result = await pool.query(
      `SELECT
        id,
        username,
        password_hash,
        is_admin,
        is_premium
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid username or password",
      });
    }

    const user = result.rows[0];

    const passwordCorrect = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordCorrect) {
      return res.status(401).json({
        error: "Invalid username or password",
      });
    }

    const token = createToken(user);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      error: "Login failed",
    });
  }
});

// ==================== CURRENT USER ====================

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, is_admin, is_premium
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Server error",
    });
  }
});

// ==================== MOVIES ====================

app.get("/api/movies", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        title,
        video_url,
        thumbnail_url,
        description,
        is_premium,
        created_at
      FROM movies
      ORDER BY created_at DESC
    `);

    res.json({
      movies: result.rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to load movies",
    });
  }
});

// ==================== WATCH MOVIE ====================

app.get("/api/movies/:id/watch", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        title,
        video_url,
        description,
        is_premium
       FROM movies
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Movie not found",
      });
    }

    const movie = result.rows[0];

    if (
      movie.is_premium &&
      !req.user.isPremium &&
      !req.user.isAdmin
    ) {
      return res.status(403).json({
        error: "Premium membership required",
      });
    }

    res.json({
      movie: {
        id: movie.id,
        title: movie.title,
        videoUrl: movie.video_url,
        description: movie.description,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to load movie",
    });
  }
});

// ==================== ADMIN ADD MOVIE ====================

app.post("/api/admin/movies", auth, adminOnly, async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    const videoUrl = String(req.body.videoUrl || "").trim();
    const thumbnailUrl = String(req.body.thumbnailUrl || "").trim();
    const description = String(req.body.description || "").trim();
    const isPremium = Boolean(req.body.isPremium);

    if (!title || !videoUrl) {
      return res.status(400).json({
        error: "Title and video URL are required",
      });
    }

    const result = await pool.query(
      `INSERT INTO movies
       (title, video_url, thumbnail_url, description, is_premium)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        title,
        videoUrl,
        thumbnailUrl,
        description,
        isPremium,
      ]
    );

    res.status(201).json({
      message: "Movie added successfully",
      movie: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to add movie",
    });
  }
});

// ==================== ADMIN DELETE MOVIE ====================

app.delete("/api/admin/movies/:id", auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM movies WHERE id = $1 RETURNING id",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Movie not found",
      });
    }

    res.json({
      message: "Movie deleted successfully",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to delete movie",
    });
  }
});

// ==================== ADMIN PREMIUM ====================

app.patch(
  "/api/admin/users/:id/premium",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const isPremium = Boolean(req.body.isPremium);

      const result = await pool.query(
        `UPDATE users
         SET is_premium = $1
         WHERE id = $2
         RETURNING id, username, is_premium`,
        [isPremium, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      res.json({
        message: "Premium status updated",
        user: result.rows[0],
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Failed to update premium status",
      });
    }
  }
);

// ==================== SETTINGS ====================

app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM site_settings ORDER BY id LIMIT 1"
    );

    if (result.rows.length === 0) {
      return res.json({
        siteName: "MovieStream",
        adText: "",
      });
    }

    const settings = result.rows[0];

    res.json({
      siteName: settings.site_name,
      adText: settings.ad_text,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to load settings",
    });
  }
});

// ==================== HEALTH ====================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

// ==================== FRONTEND ====================

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==================== START ====================

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`MovieStream running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
