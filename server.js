const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);

    const filename =
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 10) +
      ext;

    cb(null, filename);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));


// ================= DATABASE =================

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
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Database tables ready");
}


// ================= AUTH =================

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

    if (!token) {
      return res.status(401).json({
        message: "Login required"
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;

    next();

  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired login"
    });
  }
}


// ================= SIGNUP =================

app.post("/api/signup", async (req, res) => {
  try {
    const username = String(
      req.body.username || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

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

    const hashedPassword = await bcrypt.hash(
      password,
      10
    );

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


// ================= LOGIN =================

app.post("/api/login", async (req, res) => {
  try {
    const username = String(
      req.body.username || ""
    ).trim();

    const password = String(
      req.body.password || ""
    );

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


// ================= CURRENT USER =================

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


// ================= MOVIE LIST =================

app.get("/api/movies", async (req, res) => {
  try {
    const search = String(
      req.query.search || ""
    ).trim();

    const result = await pool.query(
      `
      SELECT
        movies.id,
        movies.title,
        movies.description,
        movies.video_url,
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


// ================= ADMIN UPLOAD =================

app.post(
  "/api/movies",
  authenticate,
  upload.single("video"),
  async (req, res) => {
    try {
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

      const title = String(
        req.body.title || ""
      ).trim();

      const description = String(
        req.body.description || ""
      ).trim();

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

      if (
        req.file &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        message: "Movie upload failed"
      });
    }
  }
);


// ================= DELETE MOVIE =================

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

      const result = await pool.query(
        "SELECT * FROM movies WHERE id = $1",
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          message: "Movie not found"
        });
      }

      const movie = result.rows[0];

      if (movie.video_url.startsWith("/uploads/")) {
        const filename =
          path.basename(movie.video_url);

        const filePath =
          path.join(uploadDir, filename);

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
      console.error("Delete error:", error);

      res.status(500).json({
        message: "Delete failed"
      });
    }
  }
);


// ================= ERROR HANDLER =================

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


// ================= START =================

async function startServer() {
  try {
    await createTables();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `MovieStream running on port ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "Database startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();
