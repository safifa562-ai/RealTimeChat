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


// ==================== DATABASE ====================

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sender_id, receiver_id)
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user1_id, user2_id)
    );
  `);

  console.log("Database ready");
}


// ==================== AUTH ====================

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
      message: "Invalid login"
    });
  }
}


// ==================== SIGNUP ====================

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


// ==================== LOGIN ====================

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


// ==================== CURRENT USER ====================

app.get("/api/me", authenticate, async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT id, username FROM users WHERE id = $1",
      [req.user.id]
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

    res.status(500).json({
      message: "Server error"
    });
  }
});


// ==================== SEARCH USERS ====================

app.get("/api/users", authenticate, async (req, res) => {

  try {

    const search = req.query.search || "";

    const result = await pool.query(
      `SELECT id, username
       FROM users
       WHERE username ILIKE $1
       AND id != $2
       ORDER BY username
       LIMIT 20`,
      [`%${search}%`, req.user.id]
    );

    res.json(result.rows);

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      message: "Could not search users"
    });
  }
});


// ==================== FRIEND REQUEST ====================

app.post("/api/friend-request", authenticate, async (req, res) => {

  try {

    const receiverId = Number(req.body.receiverId);

    if (!receiverId) {
      return res.status(400).json({
        message: "Invalid user"
      });
    }

    if (receiverId === req.user.id) {
      return res.status(400).json({
        message: "You cannot add yourself"
      });
    }

    const result = await pool.query(
      `INSERT INTO friend_requests
       (sender_id, receiver_id)
       VALUES ($1, $2)
       ON CONFLICT (sender_id, receiver_id)
       DO NOTHING
       RETURNING id`,
      [req.user.id, receiverId]
    );

    if (result.rows.length === 0) {
      return res.json({
        message: "Request already exists"
      });
    }

    res.json({
      message: "Friend request sent"
    });

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      message: "Could not send request"
    });
  }
});


// ==================== FRIEND REQUESTS ====================

app.get("/api/friend-requests", authenticate, async (req, res) => {

  try {

    const result = await pool.query(
      `SELECT
         fr.id,
         u.id AS user_id,
         u.username
       FROM friend_requests fr
       JOIN users u
         ON u.id = fr.sender_id
       WHERE fr.receiver_id = $1
       AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      message: "Could not load requests"
    });
  }
});


// ==================== ACCEPT / REJECT ====================

app.post("/api/friend-request/:id", authenticate, async (req, res) => {

  try {

    const requestId = Number(req.params.id);
    const action = req.body.action;

    if (!["accept", "reject"].includes(action)) {
      return res.status(400).json({
        message: "Invalid action"
      });
    }

    const request = await pool.query(
      `SELECT *
       FROM friend_requests
       WHERE id = $1
       AND receiver_id = $2
       AND status = 'pending'`,
      [requestId, req.user.id]
    );

    if (request.rows.length === 0) {
      return res.status(404).json({
        message: "Request not found"
      });
    }

    const senderId = request.rows[0].sender_id;

    if (action === "reject") {

      await pool.query(
        `UPDATE friend_requests
         SET status = 'rejected'
         WHERE id = $1`,
        [requestId]
      );

      return res.json({
        message: "Request rejected"
      });
    }

    const user1 = Math.min(senderId, req.user.id);
    const user2 = Math.max(senderId, req.user.id);

    await pool.query(
      `INSERT INTO friendships
       (user1_id, user2_id)
       VALUES ($1, $2)
       ON CONFLICT (user1_id, user2_id)
       DO NOTHING`,
      [user1, user2]
    );

    await pool.query(
      `UPDATE friend_requests
       SET status = 'accepted'
       WHERE id = $1`,
      [requestId]
    );

    res.json({
      message: "Request accepted"
    });

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      message: "Could not process request"
    });
  }
});


// ==================== FRIENDS ====================

app.get("/api/friends", authenticate, async (req, res) => {

  try {

    const result = await pool.query(
      `SELECT u.id, u.username
       FROM friendships f
       JOIN users u
       ON u.id =
          CASE
            WHEN f.user1_id = $1 THEN f.user2_id
            ELSE f.user1_id
          END
       WHERE f.user1_id = $1
       OR f.user2_id = $1
       ORDER BY u.username`,
      [req.user.id]
    );

    res.json(result.rows);

  } catch (error) {

    console.error(error.message);

    res.status(500).json({
      message: "Could not load friends"
    });
  }
});


// ==================== REAL-TIME CHAT ====================

io.on("connection", (socket) => {

  console.log("User connected:", socket.id);


  socket.on("join user", (userId) => {

    socket.join("user_" + userId);

    console.log(
      "User joined:",
      "user_" + userId
    );
  });


  socket.on("private message", (data) => {

    const {
      senderId,
      receiverId,
      senderName,
      message
    } = data;

    const messageData = {
      senderId,
      receiverId,
      senderName,
      message,
      time: new Date().toLocaleTimeString()
    };

    io.to("user_" + receiverId)
      .emit("private message", messageData);

    io.to("user_" + senderId)
      .emit("private message", messageData);
  });


  socket.on("disconnect", () => {

    console.log(
      "User disconnected:",
      socket.id
    );
  });

});


// ==================== START SERVER ====================

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
