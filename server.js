const express = require("express");
const http = require("http");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
  console.error("Missing Supabase/JWT environment variables");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/* =========================
   AUTH
========================= */

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    {
      expiresIn: "30d"
    }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}

/* =========================
   REGISTER
========================= */

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

    const { data: existing } = await supabase
      .from("users")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: "Username already exists"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        username,
        password_hash: passwordHash
      })
      .select("id, username, avatar_url, created_at")
      .single();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Registration failed"
      });
    }

    const token = createToken(user);

    res.status(201).json({
      message: "Account created",
      token,
      user
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", username)
      .maybeSingle();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Login failed"
      });
    }

    if (!user) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    await supabase
      .from("users")
      .update({
        last_seen: new Date().toISOString()
      })
      .eq("id", user.id);

    const token = createToken(user);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

/* =========================
   USERS / SEARCH
========================= */

const onlineUsers = new Map();

app.get("/api/users", auth, async (req, res) => {
  try {
    const search = String(
      req.query.search || ""
    ).trim().toLowerCase();

    let query = supabase
      .from("users")
      .select("id, username, avatar_url, last_seen")
      .neq("id", req.user.id)
      .order("username");

    if (search) {
      query = query.ilike("username", `%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Unable to load users"
      });
    }

    const users = data.map(user => ({
      ...user,
      online: onlineUsers.has(String(user.id))
    }));

    res.json(users);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Unable to load users"
    });
  }
});

/* =========================
   CHAT HISTORY
========================= */

app.get(
  "/api/messages/:userId/:otherUserId",
  auth,
  async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const otherUserId = Number(req.params.otherUserId);

      if (
        userId !== Number(req.user.id)
      ) {
        return res.status(403).json({
          error: "Access denied"
        });
      }

      const { data, error } = await supabase
        .from("messages")
        .select(`
          id,
          sender_id,
          receiver_id,
          message,
          message_type,
          file_name,
          file_url,
          file_size,
          is_read,
          is_deleted,
          created_at
        `)
        .or(
          `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
        )
        .order("created_at", {
          ascending: true
        });

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Unable to load chat history"
        });
      }

      res.json(data || []);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Unable to load chat history"
      });
    }
  }
);

/* =========================
   DELETE MESSAGE
========================= */

app.delete(
  "/api/messages/:id",
  auth,
  async (req, res) => {
    try {
      const messageId = Number(req.params.id);

      const { data: message } = await supabase
        .from("messages")
        .select("id, sender_id")
        .eq("id", messageId)
        .maybeSingle();

      if (!message) {
        return res.status(404).json({
          error: "Message not found"
        });
      }

      if (
        Number(message.sender_id) !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error: "You can only delete your own message"
        });
      }

      const { error } = await supabase
        .from("messages")
        .update({
          is_deleted: true,
          message: null
        })
        .eq("id", messageId);

      if (error) {
        return res.status(500).json({
          error: "Delete failed"
        });
      }

      io.emit("message-deleted", {
        id: messageId
      });

      res.json({
        message: "Message deleted"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Delete failed"
      });
    }
  }
);

/* =========================
   FILE UPLOAD
========================= */

app.post(
  "/api/upload",
  auth,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No file selected"
        });
      }

      const safeName = req.file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, "_");

      const filePath =
        `${req.user.id}/${Date.now()}-${safeName}`;

      const { error } = await supabase.storage
        .from("chat-files")
        .upload(
          filePath,
          req.file.buffer,
          {
            contentType: req.file.mimetype,
            upsert: false
          }
        );

      if (error) {
        console.error("STORAGE ERROR:", error);

        return res.status(500).json({
          error: "File upload failed"
        });
      }

      const { data: signed } =
        await supabase.storage
          .from("chat-files")
          .createSignedUrl(
            filePath,
            60 * 60 * 24 * 7
          );

      res.json({
        message: "File uploaded",
        file: {
          originalName: req.file.originalname,
          size: req.file.size,
          path: filePath,
          url: signed?.signedUrl || null
        }
      });

    } catch (error) {
      console.error("UPLOAD ERROR:", error);

      res.status(500).json({
        error: "File upload failed"
      });
    }
  }
);

/* =========================
   HEALTH
========================= */

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("users")
      .select("id")
      .limit(1);

    res.json({
      status: "ok",
      database: error ? "error" : "connected",
      socket: "enabled",
      storage: "enabled",
      webrtc: "enabled"
    });

  } catch {
    res.status(500).json({
      status: "error"
    });
  }
});

/* =========================
   SOCKET.IO
========================= */

io.on("connection", socket => {

  console.log(
    "Socket connected:",
    socket.id
  );

  socket.on("user-online", async user => {

    if (!user?.id) return;

    const userId = String(user.id);

    onlineUsers.set(userId, {
      socketId: socket.id,
      username: user.username
    });

    socket.userId = userId;
    socket.username = user.username;

    await supabase
      .from("users")
      .update({
        last_seen: new Date().toISOString()
      })
      .eq("id", Number(userId));

    io.emit(
      "online-users",
      Array.from(onlineUsers.keys())
    );
  });

  /* PRIVATE MESSAGE */

  socket.on(
    "private-message",
    async data => {

      try {

        const senderId =
          Number(data.senderId);

        const receiverId =
          Number(data.receiverId);

        const message =
          String(data.message || "").trim();

        if (
          !senderId ||
          !receiverId ||
          !message
        ) {
          return;
        }

        const { data: saved, error } =
          await supabase
            .from("messages")
            .insert({
              sender_id: senderId,
              receiver_id: receiverId,
              message,
              message_type:
                data.messageType || "text"
            })
            .select()
            .single();

        if (error) {
          console.error(
            "MESSAGE DB ERROR:",
            error
          );
          return;
        }

        const receiver =
          onlineUsers.get(
            String(receiverId)
          );

        if (receiver) {
          io.to(receiver.socketId).emit(
            "private-message",
            saved
          );
        }

        socket.emit(
          "private-message",
          saved
        );

      } catch (error) {
        console.error(
          "MESSAGE ERROR:",
          error
        );
      }
    }
  );

  /* TYPING */

  socket.on("typing", data => {

    const receiver =
      onlineUsers.get(
        String(data.receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "typing",
        {
          senderId: data.senderId
        }
      );
    }
  });

  /* CALL */

  socket.on("start-call", data => {

    const receiver =
      onlineUsers.get(
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

  socket.on("call-offer", data => {

    const receiver =
      onlineUsers.get(
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

  socket.on("call-answer", data => {

    const receiver =
      onlineUsers.get(
        String(data.receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "call-answer",
        data
      );
    }
  });

  socket.on("ice-candidate", data => {

    const receiver =
      onlineUsers.get(
        String(data.receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "ice-candidate",
        data
      );
    }
  });

  socket.on("end-call", data => {

    const receiver =
      onlineUsers.get(
        String(data.receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "end-call",
        data
      );
    }
  });

  socket.on("screen-share", data => {

    const receiver =
      onlineUsers.get(
        String(data.receiverId)
      );

    if (receiver) {
      io.to(receiver.socketId).emit(
        "screen-share",
        data
      );
    }
  });

  /* DISCONNECT */

  socket.on("disconnect", async () => {

    if (socket.userId) {

      onlineUsers.delete(
        socket.userId
      );

      await supabase
        .from("users")
        .update({
          last_seen:
            new Date().toISOString()
        })
        .eq(
          "id",
          Number(socket.userId)
        );
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

/* =========================
   FRONTEND FALLBACK
========================= */

app.use((req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );

});

/* =========================
   START
========================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `RealTimeChat running on port ${PORT}`
    );
  }
);
