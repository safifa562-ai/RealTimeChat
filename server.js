const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 10000;

// =========================
// MIDDLEWARE
// =========================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// =========================
// DATABASE
// =========================

const db = new Database(
  path.join(__dirname, "realtimechat.db")
);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// =========================
// USERS
// =========================

const createUser = db.prepare(`
  INSERT INTO users
  (username, password, created_at)
  VALUES (?, ?, ?)
`);

const findUser = db.prepare(`
  SELECT *
  FROM users
  WHERE username = ?
`);

const findUserById = db.prepare(`
  SELECT id, username
  FROM users
  WHERE id = ?
`);

const getAllUsers = db.prepare(`
  SELECT id, username
  FROM users
  ORDER BY username ASC
`);

// =========================
// MESSAGES
// =========================

const saveMessage = db.prepare(`
  INSERT INTO messages
  (
    sender_id,
    receiver_id,
    message,
    created_at
  )
  VALUES (?, ?, ?, ?)
`);

const getChatMessages = db.prepare(`
  SELECT
    id,
    sender_id,
    receiver_id,
    message,
    created_at
  FROM messages
  WHERE
    (
      sender_id = ?
      AND receiver_id = ?
    )
    OR
    (
      sender_id = ?
      AND receiver_id = ?
    )
  ORDER BY id ASC
`);

// =========================
// FILE UPLOAD
// =========================

const uploadDir = path.join(
  __dirname,
  "uploads"
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true
  });
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use(
  "/uploads",
  express.static(uploadDir)
);

// =========================
// TOKEN
// =========================

function createToken(user) {
  return Buffer.from(
    `${user.id}:${user.username}`
  ).toString("base64");
}

// =========================
// REGISTER
// =========================

app.post(
  "/api/register",
  (req, res) => {
    try {
      const username = String(
        req.body.username || ""
      )
        .trim()
        .toLowerCase();

      const password = String(
        req.body.password || ""
      );

      if (!username || !password) {
        return res.status(400).json({
          error:
            "Username and password are required"
        });
      }

      if (username.length < 3) {
        return res.status(400).json({
          error:
            "Username must be at least 3 characters"
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          error:
            "Password must be at least 6 characters"
        });
      }

      const existingUser =
        findUser.get(username);

      if (existingUser) {
        return res.status(409).json({
          error:
            "Username already exists"
        });
      }

      const createdAt =
        new Date().toISOString();

      const result =
        createUser.run(
          username,
          password,
          createdAt
        );

      const user = {
        id: Number(result.lastInsertRowid),
        username
      };

      console.log(
        "REGISTER:",
        username
      );

      res.status(201).json({
        message:
          "Account created",
        token: createToken(user),
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

// =========================
// LOGIN
// =========================

app.post(
  "/api/login",
  (req, res) => {
    try {
      const username = String(
        req.body.username || ""
      )
        .trim()
        .toLowerCase();

      const password = String(
        req.body.password || ""
      );

      const user =
        findUser.get(username);

      if (
        !user ||
        user.password !== password
      ) {
        return res.status(401).json({
          error:
            "Invalid username or password"
        });
      }

      const publicUser = {
        id: user.id,
        username: user.username
      };

      console.log(
        "LOGIN:",
        username
      );

      res.json({
        message:
          "Login successful",
        token:
          createToken(publicUser),
        user: publicUser
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

// =========================
// ALL USERS
// =========================

app.get(
  "/api/users",
  (req, res) => {
    try {
      const users =
        getAllUsers.all();

      const list =
        users.map(user => ({
          id: user.id,
          username: user.username,
          online:
            onlineUsers.has(
              String(user.id)
            )
        }));

      res.json(list);

    } catch (error) {
      console.error(
        "USERS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not load users"
      });
    }
  }
);

// =========================
// CHAT HISTORY
// =========================

app.get(
  "/api/messages/:userId/:otherUserId",
  (req, res) => {
    try {
      const userId =
        Number(req.params.userId);

      const otherUserId =
        Number(req.params.otherUserId);

      if (
        !userId ||
        !otherUserId
      ) {
        return res.status(400).json({
          error:
            "Invalid user IDs"
        });
      }

      const messages =
        getChatMessages.all(
          userId,
          otherUserId,
          otherUserId,
          userId
        );

      res.json(messages);

    } catch (error) {
      console.error(
        "CHAT HISTORY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not load chat history"
      });
    }
  }
);

// =========================
// FILE UPLOAD
// =========================

app.post(
  "/api/upload",
  upload.single("file"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "No file selected"
        });
      }

      res.json({
        message:
          "File uploaded",

        file: {
          originalName:
            req.file.originalname,

          filename:
            req.file.filename,

          size:
            req.file.size,

          url:
            `/uploads/${req.file.filename}`
        }
      });

    } catch (error) {
      console.error(
        "UPLOAD ERROR:",
        error
      );

      res.status(500).json({
        error:
          "File upload failed"
      });
    }
  }
);

// =========================
// HEALTH
// =========================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      database: "sqlite",
      socket: "enabled",
      webrtc: "enabled",
      chat: "enabled"
    });
  }
);

// =========================
// ONLINE USERS
// =========================

const onlineUsers = new Map();

// =========================
// SOCKET.IO
// =========================

io.on(
  "connection",
  socket => {

    console.log(
      "Socket connected:",
      socket.id
    );

    // =====================
    // USER ONLINE
    // =====================

    socket.on(
      "user-online",
      user => {

        if (
          !user ||
          !user.id
        ) {
          return;
        }

        const userId =
          String(user.id);

        onlineUsers.set(
          userId,
          {
            socketId:
              socket.id,

            username:
              user.username
          }
        );

        socket.userId =
          userId;

        socket.username =
          user.username;

        io.emit(
          "online-users",
          Array.from(
            onlineUsers.keys()
          )
        );

        console.log(
          "USER ONLINE:",
          user.username
        );
      }
    );

    // =====================
    // PRIVATE MESSAGE
    // =====================

    socket.on(
      "private-message",
      data => {

        try {

          const senderId =
            Number(
              data.senderId
            );

          const receiverId =
            Number(
              data.receiverId
            );

          const message =
            String(
              data.message || ""
            ).trim();

          if (
            !senderId ||
            !receiverId ||
            !message
          ) {
            return;
          }

          const createdAt =
            new Date().toISOString();

          const result =
            saveMessage.run(
              senderId,
              receiverId,
              message,
              createdAt
            );

          const savedMessage = {
            id:
              Number(
                result.lastInsertRowid
              ),

            sender_id:
              senderId,

            receiver_id:
              receiverId,

            message,

            created_at:
              createdAt
          };

          // Send to receiver
          const receiver =
            onlineUsers.get(
              String(receiverId)
            );

          if (receiver) {

            io.to(
              receiver.socketId
            ).emit(
              "private-message",
              savedMessage
            );
          }

          // Send back to sender
          socket.emit(
            "private-message",
            savedMessage
          );

        } catch (error) {

          console.error(
            "MESSAGE ERROR:",
            error
          );
        }
      }
    );

    // =====================
    // START CALL
    // =====================

    socket.on(
      "start-call",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

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
      }
    );

    // =====================
    // CALL OFFER
    // =====================

    socket.on(
      "call-offer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

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
      }
    );

    // =====================
    // CALL ANSWER
    // =====================

    socket.on(
      "call-answer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

          io.to(
            receiver.socketId
          ).emit(
            "call-answer",
            data
          );
        }
      }
    );

    // =====================
    // ICE CANDIDATE
    // =====================

    socket.on(
      "ice-candidate",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

          io.to(
            receiver.socketId
          ).emit(
            "ice-candidate",
            data
          );
        }
      }
    );

    // =====================
    // END CALL
    // =====================

    socket.on(
      "end-call",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

          io.to(
            receiver.socketId
          ).emit(
            "end-call",
            data
          );
        }
      }
    );

    // =====================
    // SCREEN SHARE
    // =====================

    socket.on(
      "screen-share",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (receiver) {

          io.to(
            receiver.socketId
          ).emit(
            "screen-share",
            data
          );
        }
      }
    );

    // =====================
    // CALL TRANSFER
    // =====================

    socket.on(
      "call-transfer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.newReceiverId
            )
          );

        if (receiver) {

          io.to(
            receiver.socketId
          ).emit(
            "call-transfer",
            data
          );
        }
      }
    );

    // =====================
    // DISCONNECT
    // =====================

    socket.on(
      "disconnect",
      () => {

        if (
          socket.userId
        ) {

          onlineUsers.delete(
            socket.userId
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
      }
    );
  }
);

// =========================
// FRONTEND FALLBACK
// =========================

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

// =========================
// START SERVER
// =========================

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `RealTimeChat running on port ${PORT}`
    );

  }
);
