
const express = require("express");
const http = require("http");
const path = require("path");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE"]
  }
});

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
  console.error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or JWT_SECRET"
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const onlineUsers = new Map();
const socketsById = new Map();

/* ================= AUTH ================= */

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}

function intId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function emitToUser(userId, event, payload) {
  const sockets = onlineUsers.get(String(userId));
  if (!sockets) return;

  for (const socketId of sockets) {
    io.to(socketId).emit(event, payload);
  }
}

async function getUser(id) {
  const { data, error } = await supabase
    .from("users")
    .select("id,username,avatar_url,created_at,last_seen")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function areFriends(a, b) {
  const { data, error } = await supabase
    .from("friendships")
    .select("id")
    .eq("user_id", a)
    .eq("friend_id", b)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

/* ================= HEALTH ================= */

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("users")
      .select("id")
      .limit(1);

    if (error) {
      return res.status(500).json({
        status: "ok",
        database: "error",
        error: error.message
      });
    }

    res.json({
      status: "ok",
      database: "connected",
      socket: "enabled",
      storage: "enabled",
      webrtc: "enabled"
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "error"
    });
  }
});

/* ================= REGISTER ================= */

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: "Username must be 3-30 valid characters"
      });
    }

    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({
        error: "Password must be 6-128 characters"
      });
    }

    const { data: existing, error: checkError } =
      await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .maybeSingle();

    if (checkError) throw checkError;

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
      .select("id,username,avatar_url,created_at,last_seen")
      .single();

    if (error) throw error;

    res.status(201).json({
      message: "Account created",
      token: tokenFor(user),
      user
    });
  } catch (error) {
    console.error("REGISTER:", error.message);
    res.status(500).json({
      error: "Registration failed. Check database configuration."
    });
  }
});

/* ================= LOGIN ================= */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const { data: user, error } = await supabase
      .from("users")
      .select(
        "id,username,password_hash,avatar_url,created_at,last_seen"
      )
      .eq("username", username)
      .maybeSingle();

    if (error) throw error;

    if (
      !user ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    const safeUser = {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      last_seen: user.last_seen
    };

    await supabase
      .from("users")
      .update({ last_seen: new Date().toISOString() })
      .eq("id", user.id);

    res.json({
      message: "Login successful",
      token: tokenFor(safeUser),
      user: safeUser
    });
  } catch (error) {
    console.error("LOGIN:", error.message);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ================= PROFILE ================= */

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Could not load profile" });
  }
});

/* ================= USER SEARCH ================= */

app.get("/api/users", authMiddleware, async (req, res) => {
  try {
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    let query = supabase
      .from("users")
      .select("id,username,avatar_url,created_at,last_seen")
      .neq("id", req.user.id)
      .order("username")
      .limit(100);

    if (search) {
      query = query.ilike("username", `%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json(
      (data || []).map(user => ({
        ...user,
        online: onlineUsers.has(String(user.id))
      }))
    );
  } catch (error) {
    res.status(500).json({ error: "Could not load users" });
  }
});

/* ================= FRIENDS ================= */

app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from("friendships")
      .select("friend_id")
      .eq("user_id", req.user.id);

    if (error) throw error;

    const ids = (rows || []).map(row => row.friend_id);
    if (!ids.length) return res.json([]);

    const { data, error: usersError } = await supabase
      .from("users")
      .select("id,username,avatar_url,last_seen,created_at")
      .in("id", ids);

    if (usersError) throw usersError;

    res.json(
      (data || []).map(user => ({
        ...user,
        online: onlineUsers.has(String(user.id))
      }))
    );
  } catch (error) {
    res.status(500).json({ error: "Could not load friends" });
  }
});

app.get(
  "/api/friends/requests",
  authMiddleware,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("friend_requests")
        .select("id,sender_id,receiver_id,status,created_at")
        .eq("receiver_id", req.user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const ids = [...new Set((data || []).map(r => r.sender_id))];
      let users = [];

      if (ids.length) {
        const result = await supabase
          .from("users")
          .select("id,username,avatar_url")
          .in("id", ids);

        if (result.error) throw result.error;
        users = result.data || [];
      }

      res.json(
        (data || []).map(request => ({
          ...request,
          sender: users.find(u => u.id === request.sender_id) || null
        }))
      );
    } catch (error) {
      res.status(500).json({ error: "Could not load requests" });
    }
  }
);

app.post(
  "/api/friends/request",
  authMiddleware,
  async (req, res) => {
    try {
      const receiverId = intId(req.body.receiverId);

      if (!receiverId || receiverId === Number(req.user.id)) {
        return res.status(400).json({ error: "Invalid friend ID" });
      }

      const receiver = await getUser(receiverId);
      if (!receiver) {
        return res.status(404).json({ error: "User not found" });
      }

      if (await areFriends(req.user.id, receiverId)) {
        return res.status(409).json({ error: "Already friends" });
      }

      const { data: existing, error: existingError } =
        await supabase
          .from("friend_requests")
          .select("id")
          .eq("sender_id", req.user.id)
          .eq("receiver_id", receiverId)
          .eq("status", "pending")
          .maybeSingle();

      if (existingError) throw existingError;

      if (existing) {
        return res.status(409).json({
          error: "Friend request already pending"
        });
      }

      const { data, error } = await supabase
        .from("friend_requests")
        .insert({
          sender_id: req.user.id,
          receiver_id: receiverId,
          status: "pending"
        })
        .select("*")
        .single();

      if (error) throw error;

      emitToUser(receiverId, "friend-request-received", {
        request: data,
        sender: {
          id: req.user.id,
          username: req.user.username
        }
      });

      res.status(201).json(data);
    } catch (error) {
      res.status(500).json({ error: "Could not send friend request" });
    }
  }
);

app.post(
  "/api/friends/request/:id/accept",
  authMiddleware,
  async (req, res) => {
    try {
      const id = intId(req.params.id);

      const { data: request, error } = await supabase
        .from("friend_requests")
        .select("*")
        .eq("id", id)
        .eq("receiver_id", req.user.id)
        .eq("status", "pending")
        .maybeSingle();

      if (error) throw error;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const { error: updateError } = await supabase
        .from("friend_requests")
        .update({ status: "accepted" })
        .eq("id", id);

      if (updateError) throw updateError;

      const { error: friendshipError } = await supabase
        .from("friendships")
        .upsert([
          { user_id: req.user.id, friend_id: request.sender_id },
          { user_id: request.sender_id, friend_id: req.user.id }
        ], { onConflict: "user_id,friend_id" });

      if (friendshipError) throw friendshipError;

      emitToUser(request.sender_id, "friend-request-updated", {
        status: "accepted",
        userId: req.user.id
      });

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Could not accept request" });
    }
  }
);

app.post(
  "/api/friends/request/:id/reject",
  authMiddleware,
  async (req, res) => {
    try {
      const id = intId(req.params.id);

      const { data: request, error } = await supabase
        .from("friend_requests")
        .select("id,sender_id")
        .eq("id", id)
        .eq("receiver_id", req.user.id)
        .eq("status", "pending")
        .maybeSingle();

      if (error) throw error;
      if (!request) {
        return res.status(404).json({ error: "Request not found" });
      }

      const { error: updateError } = await supabase
        .from("friend_requests")
        .update({ status: "rejected" })
        .eq("id", id);

      if (updateError) throw updateError;

      emitToUser(request.sender_id, "friend-request-updated", {
        status: "rejected",
        userId: req.user.id
      });

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Could not reject request" });
    }
  }
);

app.delete(
  "/api/friends/:friendId",
  authMiddleware,
  async (req, res) => {
    try {
      const friendId = intId(req.params.friendId);
      if (!friendId) {
        return res.status(400).json({ error: "Invalid friend ID" });
      }

      const { error } = await supabase
        .from("friendships")
        .delete()
        .or(
          `and(user_id.eq.${req.user.id},friend_id.eq.${friendId}),` +
          `and(user_id.eq.${friendId},friend_id.eq.${req.user.id})`
        );

      if (error) throw error;

      emitToUser(friendId, "friend-removed", {
        userId: req.user.id
      });

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Could not remove friend" });
    }
  }
);

/* ================= PRIVATE CHAT HISTORY ================= */

app.get(
  "/api/messages/:userId/:otherUserId",
  authMiddleware,
  async (req, res) => {
    try {
      const userId = intId(req.params.userId);
      const otherUserId = intId(req.params.otherUserId);

      if (userId !== Number(req.user.id) || !otherUserId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .or(
          `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),` +
          `and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
        )
        .order("created_at", { ascending: true })
        .limit(1000);

      if (error) throw error;
      res.json(data || []);
    } catch (error) {
      res.status(500).json({ error: "Could not load chat history" });
    }
  }
);

/* ================= READ RECEIPTS ================= */

app.patch("/api/messages/read", authMiddleware, async (req, res) => {
  try {
    const senderId = intId(req.body.senderId);
    if (!senderId) {
      return res.status(400).json({ error: "Invalid sender" });
    }

    const { error } = await supabase
      .from("messages")
      .update({ is_read: true })
      .eq("receiver_id", req.user.id)
      .eq("sender_id", senderId)
      .eq("is_read", false);

    if (error) throw error;

    emitToUser(senderId, "messages-read", {
      readerId: req.user.id
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Could not update read receipts" });
  }
});

/* ================= EDIT MESSAGE ================= */

app.patch("/api/messages/:id", authMiddleware, async (req, res) => {
  try {
    const id = intId(req.params.id);
    const message = String(req.body.message || "").trim();

    if (!id) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    if (!message || message.length > 5000) {
      return res.status(400).json({
        error: "Message must contain 1-5000 characters"
      });
    }

    const { data: oldMessage, error: findError } = await supabase
      .from("messages")
      .select("id,sender_id,receiver_id,is_deleted")
      .eq("id", id)
      .maybeSingle();

    if (findError) throw findError;

    if (!oldMessage) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (Number(oldMessage.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({
        error: "You can only edit your own messages"
      });
    }

    if (oldMessage.is_deleted) {
      return res.status(400).json({
        error: "Deleted messages cannot be edited"
      });
    }

    const editedAt = new Date().toISOString();

    const { data: updated, error: updateError } = await supabase
      .from("messages")
      .update({ message, edited_at: editedAt })
      .eq("id", id)
      .eq("sender_id", req.user.id)
      .select("*")
      .single();

    if (updateError) throw updateError;

    emitToUser(oldMessage.receiver_id, "message-edited", updated);
    res.json(updated);
  } catch (error) {
    console.error("EDIT MESSAGE:", error.message);
    res.status(500).json({
      error: "Could not edit message. Check the edited_at column."
    });
  }
});

/* ================= DELETE MESSAGE ================= */

app.delete("/api/messages/:id", authMiddleware, async (req, res) => {
  try {
    const id = intId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const { data: message, error: findError } = await supabase
      .from("messages")
      .select("id,sender_id,receiver_id,is_deleted")
      .eq("id", id)
      .maybeSingle();

    if (findError) throw findError;

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (Number(message.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({
        error: "You can only delete your own messages"
      });
    }

    const { data: deleted, error: deleteError } = await supabase
      .from("messages")
      .update({ is_deleted: true, message: null })
      .eq("id", id)
      .eq("sender_id", req.user.id)
      .select("*")
      .single();

    if (deleteError) throw deleteError;

    emitToUser(message.receiver_id, "message-deleted", {
      id,
      message: deleted
    });

    res.json({ ok: true, id });
  } catch (error) {
    console.error("DELETE MESSAGE:", error.message);
    res.status(500).json({ error: "Could not delete message" });
  }
});

/* ================= MESSAGE REACTIONS ================= */

app.post("/api/reactions", authMiddleware, async (req, res) => {
  try {
    const messageId = intId(req.body.messageId);
    const emoji = String(req.body.emoji || "").trim();

    if (!messageId || !emoji || emoji.length > 16) {
      return res.status(400).json({ error: "Invalid reaction" });
    }

    const { data, error } = await supabase
      .from("message_reactions")
      .upsert({
        message_id: messageId,
        user_id: req.user.id,
        emoji
      }, {
        onConflict: "message_id,user_id,emoji"
      })
      .select("*")
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(500).json({ error: "Could not save reaction" });
  }
});

/* ================= FILE UPLOAD ================= */

app.post(
  "/api/upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file selected" });
      }

      const safeName = req.file.originalname.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      const key = `${req.user.id}/${Date.now()}-${safeName}`;

      const { error } = await supabase.storage
        .from("chat-files")
        .upload(key, req.file.buffer, {
          contentType: req.file.mimetype || "application/octet-stream",
          upsert: false
        });

      if (error) throw error;

      const { data } = supabase.storage
        .from("chat-files")
        .getPublicUrl(key);

      res.json({
        url: data.publicUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        key
      });
    } catch (error) {
      console.error("UPLOAD:", error.message);
      res.status(500).json({
        error: "File upload failed. Check the chat-files bucket."
      });
    }
  }
);

/* ================= GROUPS ================= */

app.get("/api/groups", authMiddleware, async (req, res) => {
  try {
    const { data: memberships, error } = await supabase
      .from("group_members")
      .select("group_id")
      .eq("user_id", req.user.id);

    if (error) throw error;

    const ids = (memberships || []).map(row => row.group_id);
    if (!ids.length) return res.json([]);

    const { data, error: groupsError } = await supabase
      .from("groups")
      .select("*")
      .in("id", ids)
      .order("created_at", { ascending: false });

    if (groupsError) throw groupsError;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: "Could not load groups" });
  }
});

app.post("/api/groups", authMiddleware, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 80);

    if (!name) {
      return res.status(400).json({ error: "Group name required" });
    }

    const { data: group, error } = await supabase
      .from("groups")
      .insert({ name, created_by: req.user.id })
      .select("*")
      .single();

    if (error) throw error;

    const { error: memberError } = await supabase
      .from("group_members")
      .insert({ group_id: group.id, user_id: req.user.id });

    if (memberError) throw memberError;

    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ error: "Could not create group" });
  }
});

app.post(
  "/api/groups/:id/members",
  authMiddleware,
  async (req, res) => {
    try {
      const groupId = intId(req.params.id);
      const userId = intId(req.body.userId);

      if (!groupId || !userId) {
        return res.status(400).json({ error: "Invalid IDs" });
      }

      const { data: group, error } = await supabase
        .from("groups")
        .select("created_by")
        .eq("id", groupId)
        .maybeSingle();

      if (error) throw error;

      if (!group || Number(group.created_by) !== Number(req.user.id)) {
        return res.status(403).json({
          error: "Only group creator can add members"
        });
      }

      const { error: memberError } = await supabase
        .from("group_members")
        .upsert({
          group_id: groupId,
          user_id: userId
        }, {
          onConflict: "group_id,user_id"
        });

      if (memberError) throw memberError;

      emitToUser(userId, "group-added", { groupId });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Could not add member" });
    }
  }
);

app.get(
  "/api/groups/:id/messages",
  authMiddleware,
  async (req, res) => {
    try {
      const groupId = intId(req.params.id);

      if (!groupId) {
        return res.status(400).json({ error: "Invalid group ID" });
      }

      const { data: membership, error: memberError } = await supabase
        .from("group_members")
        .select("id")
        .eq("group_id", groupId)
        .eq("user_id", req.user.id)
        .maybeSingle();

      if (memberError) throw memberError;

      if (!membership) {
        return res.status(403).json({ error: "Not a group member" });
      }

      const { data, error } = await supabase
        .from("group_messages")
        .select("*")
        .eq("group_id", groupId)
        .order("created_at", { ascending: true })
        .limit(1000);

      if (error) throw error;
      res.json(data || []);
    } catch (error) {
      res.status(500).json({ error: "Could not load group history" });
    }
  }
);

/* ================= SOCKET AUTH ================= */

// Client must connect using:
// io({ auth: { token: localStorage.getItem("token") } })

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));

    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

/* ================= SOCKET EVENTS ================= */

io.on("connection", socket => {
  const userId = Number(socket.user.id);
  const userKey = String(userId);

  socket.userId = userId;

  if (!onlineUsers.has(userKey)) {
    onlineUsers.set(userKey, new Set());
  }

  onlineUsers.get(userKey).add(socket.id);
  socketsById.set(socket.id, userKey);

  supabase
    .from("users")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", userId)
    .then(() => {})
    .catch(() => {});

  io.emit("online-users", Array.from(onlineUsers.keys()));

  socket.on("private-message", async data => {
    try {
      const receiverId = intId(data?.receiverId);
      const message = String(data?.message || "").trim();
      const fileUrl = data?.fileUrl
        ? String(data.fileUrl).slice(0, 2048)
        : null;

      if (!receiverId || receiverId === userId) return;

      if ((!message && !fileUrl) || message.length > 5000) {
        return socket.emit("message-error", {
          error: "Invalid message"
        });
      }

      const receiver = await getUser(receiverId);
      if (!receiver) {
        return socket.emit("message-error", {
          error: "Receiver not found"
        });
      }

      const messageType = data?.messageType === "file" ? "file" : "text";

      const row = {
        sender_id: userId,
        receiver_id: receiverId,
        message: message || null,
        message_type: messageType,
        file_name: data?.fileName
          ? String(data.fileName).slice(0, 255)
          : null,
        file_url: fileUrl,
        file_size: Number(data?.fileSize) || null
      };

      const { data: saved, error } = await supabase
        .from("messages")
        .insert(row)
        .select("*")
        .single();

      if (error) throw error;

      socket.emit("private-message", saved);
      emitToUser(receiverId, "private-message", saved);
    } catch (error) {
      console.error("PRIVATE MESSAGE:", error.message);
      socket.emit("message-error", {
        error: "Message could not be saved"
      });
    }
  });

  socket.on("typing", data => {
    const receiverId = intId(data?.receiverId);
    if (!receiverId) return;

    emitToUser(receiverId, "typing", {
      senderId: userId,
      typing: !!data.typing
    });
  });

  socket.on("group-message", async data => {
    try {
      const groupId = intId(data?.groupId);
      const message = String(data?.message || "").trim();

      if (!groupId || (!message && !data?.fileUrl) || message.length > 5000) {
        return;
      }

      const { data: membership, error: memberError } = await supabase
        .from("group_members")
        .select("id")
        .eq("group_id", groupId)
        .eq("user_id", userId)
        .maybeSingle();

      if (memberError) throw memberError;
      if (!membership) return;

      const row = {
        group_id: groupId,
        sender_id: userId,
        message: message || null,
        message_type: data?.messageType === "file" ? "file" : "text",
        file_name: data?.fileName
          ? String(data.fileName).slice(0, 255)
          : null,
        file_url: data?.fileUrl || null,
        file_size: Number(data?.fileSize) || null
      };

      const { data: saved, error } = await supabase
        .from("group_messages")
        .insert(row)
        .select("*")
        .single();

      if (error) throw error;

      const { data: members, error: membersError } = await supabase
        .from("group_members")
        .select("user_id")
        .eq("group_id", groupId);

      if (membersError) throw membersError;

      for (const member of members || []) {
        emitToUser(member.user_id, "group-message", saved);
      }
    } catch (error) {
      console.error("GROUP MESSAGE:", error.message);
    }
  });

  socket.on("messages-read", data => {
    const otherUserId = intId(data?.otherUserId);
    if (otherUserId) {
      emitToUser(otherUserId, "messages-read", {
        readerId: userId
      });
    }
  });

  // WebRTC signaling relay. These events do not create a call by themselves.
  for (const eventName of [
    "start-call",
    "call-offer",
    "call-answer",
    "ice-candidate",
    "end-call",
    "screen-share"
  ]) {
    socket.on(eventName, data => {
      const receiverId = intId(
        data?.toUserId || data?.receiverId
      );

      if (!receiverId) return;

      emitToUser(receiverId, eventName, {
        ...data,
        fromUserId: userId
      });
    });
  }

  socket.on("disconnect", async () => {
    const id = socketsById.get(socket.id);
    socketsById.delete(socket.id);

    if (id && onlineUsers.has(id)) {
      const set = onlineUsers.get(id);
      set.delete(socket.id);

      if (!set.size) {
        onlineUsers.delete(id);

        await supabase
          .from("users")
          .update({ last_seen: new Date().toISOString() })
          .eq("id", userId);
      }
    }

    io.emit("online-users", Array.from(onlineUsers.keys()));
  });
});

/* ================= FRONTEND FALLBACK ================= */

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RealTimeChat running on port ${PORT}`);
});
