const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// --------------------
// Upload folder
// --------------------

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// --------------------
// Multer
// --------------------

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname);
    const filename =
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 10) +
      extension;

    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,

  limits: {
    fileSize: 500 * 1024 * 1024
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      "video/mp4",
      "video/webm",
      "video/ogg",
      "video/quicktime"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed."));
    }
  }
});

// --------------------
// Middleware
// --------------------

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

app.use("/uploads", express.static(uploadDir));

// --------------------
// Database
// --------------------

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS movies (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT DEFAULT '',
      video_url TEXT NOT NULL,
      poster_url TEXT DEFAULT '',
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Database tables ready");
}

// --------------------
// Authentication
// --------------------

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

function authenticate(req, res, next) {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({
        message: "Login required"
      });
    }

    const token = auth.split(" ")[1];

    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired login"
    });
  }
}

// --------------------
// Signup
// --------------------

app.post("/api/signup", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        message: "Username and password are required"
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        message: "Username must contain at least 3 characters"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must contain at least 6 characters"
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        message: "Username already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (username, password)
      VALUES ($1, $2)
      RETURNING id, username
      `,
      [username, hashedPassword]
    );

    const user = result.rows[0];

    const token = createToken(user);

    res.json({
      message: "Account created",
      token,
      user
    });
  } catch (error) {
    console.error("Signup error:", error);

    res.status(500).json({
      message: "Server error"
    });
  }
});

// --------------------
// Login
// --------------------

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password
    );

    if (!valid) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    const token = createToken(user);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      message: "Server error"
    });
  }
});

// --------------------
// Current user
// --------------------

app.get("/api/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    res.json({
      user: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error"
    });
  }
});

// --------------------
// Movie list
// --------------------

app.get("/api/movies", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    const result = await pool.query(
      `
      SELECT
        movies.id,
        movies.title,
        movies.description,
        movies.video_url,
        movies.poster_url,
        movies.created_at,
        users.username AS uploader
      FROM movies
      LEFT JOIN users
        ON users.id = movies.uploaded_by
      WHERE movies.title ILIKE $1
      ORDER BY movies.created_at DESC
      `,
      [`%${search}%`]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Movie list error:", error);

    res.status(500).json({
      message: "Could not load movies"
    });
  }
});

// --------------------
// Upload movie
// --------------------

app.post(
  "/api/movies",
  authenticate,
  upload.single("video"),
  async (req, res) => {
    try {
      const title = String(req.body.title || "").trim();
      const description = String(
        req.body.description || ""
      ).trim();

      // Simple admin protection:
      // Set ADMIN_USERNAME in Render Environment.
      const adminUsername =
        process.env.ADMIN_USERNAME || "";

      if (
        !adminUsername ||
        req.user.username !== adminUsername
      ) {
        if (req.file) {
          fs.unlinkSync(req.file.path);
        }

        return res.status(403).json({
          message: "Only the admin can upload movies"
        });
      }

      if (!title) {
        if (req.file) {
          fs.unlinkSync(req.file.path);
        }

        return res.status(400).json({
          message: "Movie title is required"
        });
      }

      if (!req.file) {
        return res.status(400).json({
          message: "Please select a video"
        });
      }

      const videoUrl =
        "/uploads/" + req.file.filename;

      const result = await pool.query(
        `
        INSERT INTO movies
        (title, description, video_url, uploaded_by)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [
          title,
          description,
          videoUrl,
          req.user.id
        ]
      );

      res.json({
        message: "Movie uploaded successfully",
        movie: result.rows[0]
      });
    } catch (error) {
      console.error("Upload error:", error);

      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        message: "Movie upload failed"
      });
    }
  }
);

// --------------------
// Delete movie
// --------------------

app.delete(
  "/api/movies/:id",
  authenticate,
  async (req, res) => {
    try {
      const adminUsername =
        process.env.ADMIN_USERNAME || "";

      if (req.user.username !== adminUsername) {
        return res.status(403).json({
          message: "Admin only"
        });
      }

      const movieResult = await pool.query(
        "SELECT * FROM movies WHERE id = $1",
        [req.params.id]
      );

      if (movieResult.rows.length === 0) {
        return res.status(404).json({
          message: "Movie not found"
        });
      }

      const movie = movieResult.rows[0];

      if (movie.video_url.startsWith("/uploads/")) {
        const filename = path.basename(
          movie.video_url
        );

        const filePath = path.join(
          uploadDir,
          filename
        );

        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      await pool.query(
        "DELETE FROM movies WHERE id = $1",
        [req.params.id]
      );

      res.json({
        message: "Movie deleted"
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        message: "Delete failed"
      });
    }
  }
);

// --------------------
// Upload error handler
// --------------------

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      message: "Upload error: " + error.message
    });
  }

  if (error) {
    return res.status(400).json({
      message: error.message
    });
  }

  next();
});

// --------------------
// Start server
// --------------------

async function startServer() {
  try {
    await createTables();

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `MovieStream running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Database startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();
