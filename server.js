const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 10000;

/* ---------------- BASIC SETUP ---------------- */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- FILE UPLOAD ---------------- */

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

app.use("/uploads", express.static(uploadDir));

/* ---------------- IN-MEMORY DATABASE ---------------- */

let nextUserId = 1;

const users = new Map();
const messages = [];

const onlineUsers = new Map();

/* ---------------- TOKEN ---------------- */

function createToken(user) {
  return Buffer.from(
    `${user.id}:${user.username}`
  ).toString("base64");
}

/* ---------------- REGISTER ---------------- */

app.post("/api/register", (req, res) => {
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

    for (const user of users.values()) {
      if (user.username === username) {
        return res.status(409).json({
          error: "Username already exists"
        });
      }
    }

    const user = {
      id: nextUserId++,
      username,
      password
    };

    users.set(user.id, user);

    console.log("REGISTER:", username);

    res.status(201).json({
      message: "Account created",
      token: createToken(user),
      user: {
        id: user.id,
        username: user.username
      }
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* ---------------- LOGIN ---------------- */

app.post("/api/login", (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    let foundUser = null;

    for (const user of users.values()) {
      if (
        user.username === username &&
        user.password === password
      ) {
        foundUser = user;
        break;
      }
    }

    if (!foundUser) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    console.log("LOGIN:", username);

    res.json({
      message: "Login successful",
      token: createToken(foundUser),
      user: {
        id: foundUser.id,
        username: foundUser.username
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

/* ---------------- USERS ---------------- */

app.get("/api/users", (req, res) => {
  const list = [];

  for (const user of users.values()) {
    list.push({
      id: user.id,
      username: user.username,
      online: onlineUsers.has(String(user.id))
    });
  }

  res.json(list);
});

/* ---------------- HEALTH ---------------- */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    database: "not-required",
    socket: "enabled",
    webrtc: "enabled"
  });
});

/* ---------------- FILE UPLOAD ---------------- */

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

/* ---------------- SOCKET.IO ---------------- */

io.on("connection", (socket) => {

  console.log("Socket connected:", socket.id);

  /* USER ONLINE */

  socket.on("user-online", (user) => {

    if (!user || !user.id) return;

    const userId = String(user.id);

    onlineUsers.set(userId, {
      socketId: socket.id,
      username: user.username
    });

    socket.userId = userId;
    socket.username = user.username;

    io.emit(
      "online-users",
      Array.from(onlineUsers.keys())
    );

    console.log(
      "USER ONLINE:",
      user.username
    );
  });

  /* PRIVATE MESSAGE */

  socket.on("private-message", (data) => {

    try {
      const {
        senderId,
        receiverId,
        message
      } = data;

      if (!senderId || !receiverId || !message) {
        return;
      }

      const savedMessage = {
        id: messages.length + 1,
        sender_id: Number(senderId),
        receiver_id: Number(receiverId),
        message: String(message),
        created_at: new Date().toISOString()
      };

      messages.push(savedMessage);

      const receiver = onlineUsers.get(
        String(receiverId)
      );

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
      console.error(
        "MESSAGE ERROR:",
        error
      );
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

    console.log(
      "Socket disconnected:",
      socket.id
    );
  });

});

/* ---------------- FRONTEND FALLBACK ---------------- */

app.use((req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* ---------------- START SERVER ---------------- */

server.listen(PORT, "0.0.0.0", () => {

  console.log(
    `Real-time communication app running on port ${PORT}`
  );

});
