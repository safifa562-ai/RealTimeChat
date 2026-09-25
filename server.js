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
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Database setup
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      video_url TEXT NOT NULL,
      thumbnail_url TEXT,
      description TEXT,
      is_premium BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id SERIAL PRIMARY KEY,
      site_name TEXT DEFAULT 'MovieStream',
      ad_text TEXT DEFAULT '',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Database tables ready");
}

// JWT
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

// Authentication middleware
function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const token = header.split(" ")[1];

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
}

// Admin middleware
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
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Server error",
    });
  }
}

// Register
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

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rows.length) {
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

    res.json({
      message: "Account created successfully",
      token,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: user.is_admin,
        isPremium: user.is_premium,
      },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({
      error: "Registration failed",
    });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, password_hash, is_admin, is_premium
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Invalid username or password",
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
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
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      error: "Login failed",
    });
  }
});

// Current user
app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, is_admin, is_premium
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Server error",
    });
  }
});

// Get movies
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
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load movies",
    });
  }
});

// Watch movie
app.get("/api/movies/:id/watch", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, video_url, description, is_premium
       FROM movies
       WHERE id = $1`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Movie not found",
      });
    }

    const movie = result.rows[0];

    if (movie.is_premium && !req.user.isPremium && !req.user.isAdmin) {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load movie",
    });
  }
});

// Admin: add movie
app.post("/api/admin/movies", auth, adminOnly, async (req, res) => {
  try {
    const {
      title,
      videoUrl,
      thumbnailUrl,
      description,
      isPremium,
    } = req.body;

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
        thumbnailUrl || "",
        description || "",
        Boolean(isPremium),
      ]
    );

    res.json({
      message: "Movie added successfully",
      movie: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to add movie",
    });
  }
});

// Admin: delete movie
app.delete("/api/admin/movies/:id", auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM movies WHERE id = $1 RETURNING id",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Movie not found",
      });
    }

    res.json({
      message: "Movie deleted successfully",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to delete movie",
    });
  }
});

// Admin: change premium status
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

      if (!result.rows.length) {
        return res.status(404).json({
          error: "User not found",
        });
      }

      res.json({
        message: "Premium status updated",
        user: result.rows[0],
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({
        error: "Failed to update premium status",
      });
    }
  }
);

// Settings
app.get("/api/settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM site_settings ORDER BY id LIMIT 1"
    );

    if (!result.rows.length) {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to load settings",
    });
  }
});

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      status: "error",
      database: "disconnected",
    });
  }
});

// Frontend fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
initDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`MovieStream running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
