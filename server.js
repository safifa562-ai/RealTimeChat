const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

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
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));


// ================= DATABASE =================

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database ready");
}


// ================= TOKEN =================

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}


// ================= REGISTER =================

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required"
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        error: "Username must be at least 3 characters"
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

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users
       (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username`,
      [username, passwordHash]
    );

    const user = result.rows[0];

    const token = createToken(user);

    res.status(201).json({
      message: "Account created",
      token: token,
      user: user
    });

  } catch (error) {

    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});


// ================= LOGIN =================

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        error: "Username and password are required"
      });
    }

    const result = await pool.query(
      `SELECT id, username, password_hash
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const user = result.rows[0];

    const correct = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!correct) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const token = createToken(user);

    res.json({
      message: "Login successful",
      token: token,
      user: {
        id: user.id,
        username: user.username
      }
    });

  } catch (error) {

    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});


// ================= HEALTH =================

app.get("/health", async (req, res) => {
  try {

    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected"
    });

  } catch (error) {

    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});


// ================= START =================

setupDatabase()
  .then(() => {

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `MovieStream running on port ${PORT}`
      );
    });

  })
  .catch((error) => {

    console.error(
      "Database setup failed:",
      error
    );

    process.exit(1);
  });
