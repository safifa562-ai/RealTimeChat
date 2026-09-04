const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

app.use(express.json());
app.use(express.static("public"));


// =========================
// DATABASE TABLE
// =========================

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Database ready");
}


// =========================
// SIGNUP
// =========================

app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: "Username and password are required"
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        message: "Username must be at least 3 characters"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters"
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        message: "Username already exists"
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, password)
       VALUES ($1, $2)
       RETURNING id, username`,
      [username, hashedPassword]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username
      },
      JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({
      message: "Account created successfully",
      token,
      user
    });

  } catch (error) {
    console.error("Signup error:", error.message);

    res.status(500).json({
      message: "Server error"
    });
  }
});


// =========================
// LOGIN
// =========================

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: "Username and password are required"
      });
    }

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

    const passwordMatch = await bcrypt.compare(
      password,
      user.password
    );

    if (!passwordMatch) {
      return res.status(401).json({
        message: "Invalid username or password"
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username
      },
      JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username
      }
    });

  } catch (error) {
    console.error("Login error:", error.message);

    res.status(500).json({
      message: "Server error"
    });
  }
});


// =========================
// CHECK LOGIN
// =========================

app.get("/api/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({
        message: "Not logged in"
      });
    }

    const token = auth.split(" ")[1];

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      "SELECT id, username FROM users WHERE id = $1",
      [decoded.id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "User not found"
      });
    }

    res.json({
      user: result.rows[0]
    });

  } catch (error) {
    res.status(401).json({
      message: "Invalid or expired login"
    });
  }
});


// =========================
// REAL-TIME CHAT
// =========================

io.on("connection", (socket) => {

  console.log("User connected:", socket.id);


  socket.on("chat message", (data) => {

    io.emit("chat message", {
      name: data.name,
      message: data.message,
      time: new Date().toLocaleTimeString()
    });

  });


  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });

});


// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;

createTables()
  .then(() => {

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Real-Time Chat Server running on port ${PORT}`
      );
    });

  })
  .catch((error) => {

    console.error(
      "Database startup error:",
      error.message
    );

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Server running without database on port ${PORT}`
      );
    });

  });
