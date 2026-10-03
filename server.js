const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");

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
  ssl: {
    rejectUnauthorized: false
  }
});

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      sender_id INTEGER,
      receiver_id INTEGER,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database ready");
}

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

/* REGISTER */
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

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username`,
      [username, passwordHash]
    );

    const user = result.rows[0];

    res.status(201).json({
      message: "Account created",
      token: createToken(user),
      user
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* LOGIN */
app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, password_hash
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (!result.rows.length) {
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

    res.json({
      message: "Login successful",
      token: createToken(user),
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

/* HEALTH */
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
      socket: "enabled",
      webrtc: "enabled"
    });

  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

/* FILE UPLOAD */
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file selected"
      });
    }

    res.json({
      message: "File uploaded",
      file: {
        originalName: req.file.originalname,
        filename: req.file.filename,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`
      }
    });

  } catch (error) {
    console.error("UPLOAD ERROR:", error);

    res.status(500).json({
      error: "File upload failed"
    });
  }
});

/* SOCKET.IO */
const onlineUsers = new Map();

io.on("connection", (socket) => {

  console.log("Socket connected:", socket.id);

  /* USER ONLINE */
  socket.on("user-online", (user) => {

    if (!user || !user.id) return;

    onlineUsers.set(String(user.id), {
      socketId: socket.id,
      username: user.username
    });

    socket.userId = String(user.id);
    socket.username = user.username;

    io.emit("online-users", Array.from(onlineUsers.keys()));
  });

  /* TEXT MESSAGE */
  socket.on("private-message", async (data) => {

    try {
      const {
        senderId,
        receiverId,
        message
      } = data;

      if (!senderId || !receiverId || !message) return;

      const result = await pool.query(
        `INSERT INTO messages
         (sender_id, receiver_id, message)
         VALUES ($1, $2, $3)
         RETURNING id, sender_id, receiver_id, message, created_at`,
        [senderId, receiverId, message]
      );

      const savedMessage = result.rows[0];

      const receiver = onlineUsers.get(String(receiverId));

      if (receiver) {
        io.to(receiver.socketId).emit(
          "private-message",
          savedMessage
        );
      }

      socket.emit(
        "private-message",
        savedMessage
      );

    } catch (error) {
      console.error("MESSAGE ERROR:", error);
    }
  });

  /* WEBRTC OFFER */
  socket.on("call-offer", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "call-offer",
        {
          ...data,
          callerSocketId: socket.id
        }
      );
    }
  });

  /* WEBRTC ANSWER */
  socket.on("call-answer", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "call-answer",
        data
      );
    }
  });

  /* ICE CANDIDATE */
  socket.on("ice-candidate", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "ice-candidate",
        data
      );
    }
  });

  /* START CALL */
  socket.on("start-call", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "incoming-call",
        {
          ...data,
          callerSocketId: socket.id
        }
      );
    }
  });

  /* END CALL */
  socket.on("end-call", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "end-call",
        data
      );
    }
  });

  /* SCREEN SHARE */
  socket.on("screen-share", (data) => {

    const receiver = onlineUsers.get(
      String(data.receiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "screen-share",
        data
      );
    }
  });

  /* CALL TRANSFER */
  socket.on("call-transfer", (data) => {

    const receiver = onlineUsers.get(
      String(data.newReceiverId)
    );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "call-transfer",
        data
      );
    }
  });

  /* DISCONNECT */
  socket.on("disconnect", () => {

    if (socket.userId) {
      onlineUsers.delete(socket.userId);
    }

    io.emit(
      "online-users",
      Array.from(onlineUsers.keys())
    );

    console.log("Socket disconnected:", socket.id);
  });
});

/* START SERVER */
setupDatabase()
  .then(() => {

    server.listen(PORT, "0.0.0.0", () => {

      console.log(
        `Real-time communication server running on port ${PORT}`
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
