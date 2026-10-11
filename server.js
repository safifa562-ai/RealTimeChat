
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
  cors: { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !JWT_SECRET) {
  console.error("Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or JWT_SECRET");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const onlineUsers = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function numberId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function emitToUser(userId, event, data) {
  const entry = onlineUsers.get(String(userId));
  if (entry) io.to(entry.socketId).emit(event, data);
}

/* HEALTH */

app.get("/health", async (req, res) => {
  try {
    const { error } = await supabase.from("users").select("id").limit(1);
    res.status(error ? 503 : 200).json({
      status: error ? "error" : "ok",
      database: error ? "error" : "connected",
      socket: "enabled",
      storage: "configured",
      webrtc: "signaling enabled"
    });
  } catch {
    res.status(503).json({ status: "error", database: "error" });
  }
});

/* REGISTER */

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      return res.status(400).json({
        error: "Username must be 3–30 characters: letters, numbers, _, . or -"
      });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 8–128 characters" });
    }

    const { data: existing, error: checkError } = await supabase
      .from("users").select("id").eq("username", username).maybeSingle();

    if (checkError) {
      console.error("REGISTER CHECK:", checkError);
      return res.status(500).json({ error: "Database error" });
    }
    if (existing) return res.status(409).json({ error: "Username already exists" });

    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error } = await supabase
      .from("users")
      .insert({ username, password_hash })
      .select("id,username,avatar_url,created_at")
      .single();

    if (error) {
      console.error("REGISTER:", error);
      return res.status(500).json({ error: "Registration failed" });
    }

    res.status(201).json({
      message: "Account created",
      token: createToken(user),
      user
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* LOGIN */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const { data: user, error } = await supabase
      .from("users")
      .select("id,username,password_hash,avatar_url,created_at")
      .eq("username", username)
      .maybeSingle();

    if (error) {
      console.error("LOGIN DB:", error);
      return res.status(500).json({ error: "Database error" });
    }
    if (!user || !user.password_hash ||
        !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    await supabase.from("users")
      .update({ last_seen: new Date().toISOString() }).eq("id", user.id);

    delete user.password_hash;
    res.json({ message: "Login successful", token: createToken(user), user });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

/* CURRENT PROFILE */

app.get("/api/me", authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from("users")
    .select("id,username,avatar_url,created_at,last_seen")
    .eq("id", req.user.id).maybeSingle();

  if (error) {
    console.error("PROFILE:", error);
    return res.status(500).json({ error: "Could not load profile" });
  }
  if (!data) return res.status(404).json({ error: "User not found" });
  res.json(data);
});

/* USER SEARCH */

app.get("/api/users", authMiddleware, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().slice(0, 60);
    let query = supabase.from("users")
      .select("id,username,avatar_url,last_seen,created_at")
      .neq("id", req.user.id).order("username").limit(100);

    if (search) query = query.ilike("username", `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;

    res.json((data || []).map(u => ({
      ...u, online: onlineUsers.has(String(u.id))
    })));
  } catch (error) {
    console.error("USERS:", error);
    res.status(500).json({ error: "Could not load users" });
  }
});

/* FRIEND REQUESTS */

app.post("/api/friends/request", authMiddleware, async (req, res) => {
  try {
    const senderId = Number(req.user.id);
    const receiverId = numberId(req.body.receiverId);

    if (!receiverId || receiverId === senderId) {
      return res.status(400).json({ error: "Invalid receiver" });
    }

    const { data: receiver, error: receiverError } = await supabase
      .from("users").select("id").eq("id", receiverId).maybeSingle();

    if (receiverError) throw receiverError;
    if (!receiver) return res.status(404).json({ error: "User not found" });

    const { data: existingFriend, error: friendCheckError } = await supabase
      .from("friendships").select("id")
      .eq("user_id", senderId).eq("friend_id", receiverId).maybeSingle();

    if (friendCheckError) throw friendCheckError;
    if (existingFriend) return res.status(409).json({ error: "Already friends" });

    const { data: pending, error: pendingError } = await supabase
      .from("friend_requests").select("id")
      .eq("sender_id", senderId).eq("receiver_id", receiverId)
      .eq("status", "pending").maybeSingle();

    if (pendingError) throw pendingError;
    if (pending) return res.status(409).json({ error: "Request already pending" });

    const { data, error } = await supabase.from("friend_requests")
      .insert({ sender_id: senderId, receiver_id: receiverId, status: "pending" })
      .select("*").single();

    if (error) throw error;
    emitToUser(receiverId, "friend-request", data);
    res.status(201).json(data);
  } catch (error) {
    console.error("FRIEND REQUEST:", error);
    res.status(500).json({ error: "Could not send friend request" });
  }
});

app.get("/api/friends/requests", authMiddleware, async (req, res) => {
  try {
    const { data: requests, error } = await supabase.from("friend_requests")
      .select("*").eq("receiver_id", req.user.id).eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) throw error;
    const ids = (requests || []).map(r => r.sender_id);
    let users = [];

    if (ids.length) {
      const result = await supabase.from("users")
        .select("id,username,avatar_url,last_seen").in("id", ids);
      if (result.error) throw result.error;
      users = result.data || [];
    }

    const byId = new Map(users.map(u => [Number(u.id), u]));
    res.json((requests || []).map(r => ({
      ...r, sender: byId.get(Number(r.sender_id)) || null
    })));
  } catch (error) {
    console.error("FRIEND REQUESTS:", error);
    res.status(500).json({ error: "Could not load requests" });
  }
});

app.post("/api/friends/respond", authMiddleware, async (req, res) => {
  try {
    const requestId = numberId(req.body.requestId);
    const action = String(req.body.action || "").toLowerCase();

    if (!requestId || !["accept", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const { data: request, error } = await supabase.from("friend_requests")
      .select("*").eq("id", requestId).eq("receiver_id", req.user.id)
      .eq("status", "pending").maybeSingle();

    if (error) throw error;
    if (!request) return res.status(404).json({ error: "Request not found" });

    const status = action === "accept" ? "accepted" : "rejected";
    const { error: updateError } = await supabase.from("friend_requests")
      .update({ status }).eq("id", requestId);

    if (updateError) throw updateError;

    if (action === "accept") {
      const rows = [
        { user_id: Number(req.user.id), friend_id: Number(request.sender_id), status: "accepted" },
        { user_id: Number(request.sender_id), friend_id: Number(req.user.id), status: "accepted" }
      ];
      const { error: insertError } = await supabase.from("friendships")
        .upsert(rows, { onConflict: "user_id,friend_id", ignoreDuplicates: true });
      if (insertError) throw insertError;
      emitToUser(request.sender_id, "friend-accepted", { userId: Number(req.user.id) });
    } else {
      emitToUser(request.sender_id, "friend-request-rejected", { userId: Number(req.user.id) });
    }

    res.json({ success: true, status });
  } catch (error) {
    console.error("FRIEND RESPOND:", error);
    res.status(500).json({ error: "Could not update friend request" });
  }
});

app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const { data: rows, error } = await supabase.from("friendships")
      .select("friend_id").eq("user_id", req.user.id);
    if (error) throw error;

    const ids = (rows || []).map(r => r.friend_id);
    if (!ids.length) return res.json([]);

    const { data, error: userError } = await supabase.from("users")
      .select("id,username,avatar_url,last_seen,created_at")
      .in("id", ids).order("username");

    if (userError) throw userError;
    res.json((data || []).map(u => ({ ...u, online: onlineUsers.has(String(u.id)) })));
  } catch (error) {
    console.error("FRIENDS:", error);
    res.status(500).json({ error: "Could not load friends" });
  }
});

app.delete("/api/friends/:friendId", authMiddleware, async (req, res) => {
  try {
    const me = Number(req.user.id);
    const friendId = numberId(req.params.friendId);
    if (!friendId || friendId === me) return res.status(400).json({ error: "Invalid friend" });

    const first = await supabase.from("friendships").delete()
      .eq("user_id", me).eq("friend_id", friendId);
    const second = await supabase.from("friendships").delete()
      .eq("user_id", friendId).eq("friend_id", me);

    if (first.error || second.error) throw first.error || second.error;
    emitToUser(friendId, "friend-removed", { userId: me });
    res.json({ success: true });
  } catch (error) {
    console.error("REMOVE FRIEND:", error);
    res.status(500).json({ error: "Could not remove friend" });
  }
});

/* PRIVATE CHAT HISTORY */

app.get("/api/messages/:userId/:otherUserId", authMiddleware, async (req, res) => {
  try {
    const userId = numberId(req.params.userId);
    const otherId = numberId(req.params.otherUserId);

    if (!userId || !otherId || userId !== Number(req.user.id)) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { data, error } = await supabase.from("messages").select("*")
      .or(`and(sender_id.eq.${userId},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${userId})`)
      .order("created_at", { ascending: true }).limit(500);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("CHAT HISTORY:", error);
    res.status(500).json({ error: "Could not load chat history" });
  }
});

/* SEARCH MESSAGES */

app.get("/api/messages/search", authMiddleware, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const otherId = numberId(req.query.userId);
    const me = Number(req.user.id);
    if (!q || !otherId) return res.json([]);

    const { data, error } = await supabase.from("messages").select("*")
      .or(`and(sender_id.eq.${me},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${me})`)
      .ilike("message", `%${q}%`).order("created_at", { ascending: false }).limit(100);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("MESSAGE SEARCH:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

/* EDIT MESSAGE: sender only, within 15 minutes */

app.patch("/api/messages/:id/edit", authMiddleware, async (req, res) => {
  try {
    const messageId = numberId(req.params.id);
    const text = String(req.body.message || "").trim();

    if (!messageId || !text || text.length > 4000) {
      return res.status(400).json({ error: "Message must be 1–4000 characters" });
    }

    const { data: existing, error } = await supabase.from("messages")
      .select("id,sender_id,receiver_id,message,message_type,created_at,is_deleted")
      .eq("id", messageId).maybeSingle();

    if (error) throw error;
    if (!existing) return res.status(404).json({ error: "Message not found" });
    if (Number(existing.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can only edit your own messages" });
    }
    if (existing.is_deleted) return res.status(400).json({ error: "Deleted message cannot be edited" });
    if (existing.message_type && existing.message_type !== "text") {
      return res.status(400).json({ error: "Only text messages can be edited" });
    }

    const createdAt = new Date(existing.created_at).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60 * 1000 || Date.now() < createdAt) {
      return res.status(400).json({ error: "Edit allowed only within 15 minutes" });
    }

    const { data: updated, error: updateError } = await supabase.from("messages")
      .update({ message: text, is_edited: true }).eq("id", messageId).select("*").single();

    if (updateError) throw updateError;

    emitToUser(updated.sender_id, "message-edited", updated);
    emitToUser(updated.receiver_id, "message-edited", updated);
    res.json({ success: true, message: updated });
  } catch (error) {
    console.error("EDIT MESSAGE:", error);
    res.status(500).json({ error: "Could not edit message; check the database migration" });
  }
});

/* DELETE FOR EVERYONE (soft delete) */

app.delete("/api/messages/:id", authMiddleware, async (req, res) => {
  try {
    const messageId = numberId(req.params.id);
    if (!messageId) return res.status(400).json({ error: "Invalid message ID" });

    const { data: message, error } = await supabase.from("messages")
      .select("id,sender_id,receiver_id").eq("id", messageId).maybeSingle();

    if (error) throw error;
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (Number(message.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can only delete your own messages" });
    }

    const { error: deleteError } = await supabase.from("messages")
      .update({ is_deleted: true, message: null, file_name: null, file_url: null })
      .eq("id", messageId);

    if (deleteError) throw deleteError;

    const eventData = { id: messageId, is_deleted: true };
    emitToUser(message.sender_id, "message-deleted", eventData);
    emitToUser(message.receiver_id, "message-deleted", eventData);
    res.json({ success: true });
  } catch (error) {
    console.error("DELETE MESSAGE:", error);
    res.status(500).json({ error: "Could not delete message" });
  }
});

/* REACTIONS */

app.get("/api/messages/:messageId/reactions", authMiddleware, async (req, res) => {
  try {
    const messageId = numberId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: "Invalid message ID" });

    const { data: message, error: messageError } = await supabase.from("messages")
      .select("sender_id,receiver_id").eq("id", messageId).maybeSingle();

    if (messageError) throw messageError;
    if (!message || ![Number(message.sender_id), Number(message.receiver_id)].includes(Number(req.user.id))) {
      return res.status(404).json({ error: "Message not found" });
    }

    const { data, error } = await supabase.from("message_reactions")
      .select("id,message_id,user_id,emoji").eq("message_id", messageId);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("REACTIONS:", error);
    res.status(500).json({ error: "Could not load reactions" });
  }
});

app.post("/api/messages/:messageId/reactions", authMiddleware, async (req, res) => {
  try {
    const messageId = numberId(req.params.messageId);
    const emoji = String(req.body.emoji || "").trim();
    if (!messageId || !emoji || emoji.length > 16) {
      return res.status(400).json({ error: "Invalid reaction" });
    }

    const { data: message, error: messageError } = await supabase.from("messages")
      .select("sender_id,receiver_id").eq("id", messageId).maybeSingle();
    if (messageError) throw messageError;
    if (!message || ![Number(message.sender_id), Number(message.receiver_id)].includes(Number(req.user.id))) {
      return res.status(404).json({ error: "Message not found" });
    }

    const { data, error } = await supabase.from("message_reactions")
      .upsert({ message_id: messageId, user_id: Number(req.user.id), emoji },
        { onConflict: "message_id,user_id,emoji" }).select("*").single();
    if (error) throw error;

    emitToUser(message.sender_id, "reaction-updated", { messageId });
    emitToUser(message.receiver_id, "reaction-updated", { messageId });
    res.json(data);
  } catch (error) {
    console.error("ADD REACTION:", error);
    res.status(500).json({ error: "Could not add reaction" });
  }
});

app.delete("/api/messages/:messageId/reactions/:emoji", authMiddleware, async (req, res) => {
  try {
    const messageId = numberId(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: "Invalid message ID" });

    const { error } = await supabase.from("message_reactions").delete()
      .eq("message_id", messageId).eq("user_id", Number(req.user.id))
      .eq("emoji", req.params.emoji);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error("REMOVE REACTION:", error);
    res.status(500).json({ error: "Could not remove reaction" });
  }
});

/* GROUPS */

app.get("/api/groups", authMiddleware, async (req, res) => {
  try {
    const { data: memberships, error } = await supabase.from("group_members")
      .select("group_id").eq("user_id", Number(req.user.id));
    if (error) throw error;

    const ids = (memberships || []).map(m => m.group_id);
    if (!ids.length) return res.json([]);

    const { data, error: groupsError } = await supabase.from("groups")
      .select("*").in("id", ids).order("created_at", { ascending: false });
    if (groupsError) throw groupsError;
    res.json(data || []);
  } catch (error) {
    console.error("GROUPS:", error);
    res.status(500).json({ error: "Could not load groups" });
  }
});

app.post("/api/groups", authMiddleware, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name || name.length > 80) return res.status(400).json({ error: "Invalid group name" });

    const { data: group, error } = await supabase.from("groups")
      .insert({ name, created_by: Number(req.user.id) }).select("*").single();
    if (error) throw error;

    const { error: memberError } = await supabase.from("group_members")
      .insert({ group_id: group.id, user_id: Number(req.user.id) });
    if (memberError) throw memberError;

    res.status(201).json(group);
  } catch (error) {
    console.error("CREATE GROUP:", error);
    res.status(500).json({ error: "Could not create group" });
  }
});

app.post("/api/groups/:groupId/members", authMiddleware, async (req, res) => {
  try {
    const groupId = numberId(req.params.groupId);
    const userId = numberId(req.body.userId);
    if (!groupId || !userId) return res.status(400).json({ error: "Invalid group or user" });

    const { data: group, error } = await supabase.from("groups")
      .select("created_by").eq("id", groupId).maybeSingle();
    if (error) throw error;
    if (!group || Number(group.created_by) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Only group creator can add members" });
    }

    const { error: addError } = await supabase.from("group_members")
      .upsert({ group_id: groupId, user_id: userId },
        { onConflict: "group_id,user_id", ignoreDuplicates: true });
    if (addError) throw addError;

    res.json({ success: true });
  } catch (error) {
    console.error("ADD GROUP MEMBER:", error);
    res.status(500).json({ error: "Could not add group member" });
  }
});

app.get("/api/groups/:groupId/messages", authMiddleware, async (req, res) => {
  try {
    const groupId = numberId(req.params.groupId);
    if (!groupId) return res.status(400).json({ error: "Invalid group ID" });

    const { data: member, error: memberError } = await supabase.from("group_members")
      .select("id").eq("group_id", groupId).eq("user_id", Number(req.user.id)).maybeSingle();
    if (memberError) throw memberError;
    if (!member) return res.status(403).json({ error: "Not a group member" });

    const { data, error } = await supabase.from("group_messages")
      .select("*").eq("group_id", groupId).order("created_at").limit(500);
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error("GROUP HISTORY:", error);
    res.status(500).json({ error: "Could not load group messages" });
  }
});

/* FILE UPLOAD TO SUPABASE STORAGE */

app.post("/api/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file selected" });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const filePath = `${req.user.id}/${Date.now()}-${safeName}`;

    const { error } = await supabase.storage.from("chat-files").upload(
      filePath, req.file.buffer,
      { contentType: req.file.mimetype, upsert: false }
    );
    if (error) throw error;

    // Requires the "chat-files" bucket to be public for this URL approach.
    const { data } = supabase.storage.from("chat-files").getPublicUrl(filePath);

    res.json({
      success: true,
      file: {
        name: req.file.originalname,
        size: req.file.size,
        type: req.file.mimetype,
        path: filePath,
        url: data.publicUrl
      }
    });
  } catch (error) {
    console.error("UPLOAD:", error);
    res.status(500).json({ error: "File upload failed; check chat-files storage bucket" });
  }
});

/* SOCKET.IO: REAL-TIME CHAT AND WEBRTC SIGNALING */

io.on("connection", socket => {
  console.log("Socket connected:", socket.id);

  socket.on("user-online", async payload => {
    try {
      // Compatibility with the existing frontend.
      // For production, authenticate sockets with the JWT token instead of trusting a client-supplied ID.
      const userId = numberId(payload && payload.id);
      if (!userId) return;

      const username = String(payload.username || "").slice(0, 30);
      onlineUsers.set(String(userId), { socketId: socket.id, username });
      socket.userId = String(userId);
      socket.username = username;

      await supabase.from("users")
        .update({ last_seen: new Date().toISOString() }).eq("id", userId);

      io.emit("online-users", Array.from(onlineUsers.keys()));
    } catch (error) {
      console.error("USER ONLINE:", error);
    }
  });

  socket.on("private-message", async payload => {
    try {
      const senderId = numberId(payload && payload.senderId);
      const receiverId = numberId(payload && payload.receiverId);

      if (!senderId || !receiverId || senderId !== Number(socket.userId)) {
        return socket.emit("message-error", { error: "Not authorized" });
      }

      const messageType = payload.messageType === "file" ? "file" : "text";
      const message = String(payload.message || "").trim();
      if (messageType === "text" && (!message || message.length > 4000)) {
        return socket.emit("message-error", { error: "Invalid message" });
      }

      const insertData = {
        sender_id: senderId,
        receiver_id: receiverId,
        message: message || null,
        message_type: messageType,
        file_name: payload.fileName || null,
        file_url: payload.fileUrl || null,
        file_size: payload.fileSize ? Number(payload.fileSize) : null
      };

      const { data: saved, error } = await supabase.from("messages")
        .insert(insertData).select("*").single();

      if (error) {
        console.error("SAVE MESSAGE:", error);
        return socket.emit("message-error", { error: "Message could not be saved" });
      }

      emitToUser(receiverId, "private-message", saved);
      socket.emit("private-message", saved);
    } catch (error) {
      console.error("PRIVATE MESSAGE:", error);
      socket.emit("message-error", { error: "Message failed" });
    }
  });

  socket.on("typing", payload => {
    if (Number(payload.senderId) !== Number(socket.userId)) return;
    emitToUser(payload.receiverId, "typing", {
      senderId: Number(socket.userId),
      typing: Boolean(payload.typing)
    });
  });

  socket.on("messages-read", async payload => {
    try {
      const senderId = numberId(payload && payload.senderId);
      const receiverId = numberId(socket.userId);
      if (!senderId || !receiverId) return;

      const { error } = await supabase.from("messages")
        .update({ is_read: true })
        .eq("sender_id", senderId).eq("receiver_id", receiverId).eq("is_read", false);

      if (error) throw error;
      emitToUser(senderId, "messages-read", { byUserId: receiverId });
    } catch (error) {
      console.error("READ RECEIPT:", error);
    }
  });

  /* These are WebRTC signaling events, not the audio/video media itself. */
  const signalingEvents = [
    "start-call", "call-offer", "call-answer", "ice-candidate",
    "end-call", "screen-share", "call-transfer"
  ];

  for (const eventName of signalingEvents) {
    socket.on(eventName, payload => {
      if (!payload || typeof payload !== "object") return;

      const targetId = eventName === "call-transfer"
        ? numberId(payload.newReceiverId)
        : numberId(payload.receiverId);

      if (!targetId) return;
      emitToUser(targetId, eventName, {
        ...payload,
        callerSocketId: socket.id
      });
    });
  }

  socket.on("join-group", async payload => {
    try {
      const groupId = numberId(payload && payload.groupId);
      const userId = numberId(socket.userId);
      if (!groupId || !userId) return;

      const { data: member, error } = await supabase.from("group_members")
        .select("id").eq("group_id", groupId).eq("user_id", userId).maybeSingle();

      if (error) throw error;
      if (member) socket.join(`group:${groupId}`);
    } catch (error) {
      console.error("JOIN GROUP:", error);
    }
  });

  socket.on("group-message", async payload => {
    try {
      const groupId = numberId(payload && payload.groupId);
      const senderId = numberId(socket.userId);
      const message = String(payload && payload.message || "").trim();

      if (!groupId || !senderId || !message || message.length > 4000) return;

      const { data: member, error: memberError } = await supabase.from("group_members")
        .select("id").eq("group_id", groupId).eq("user_id", senderId).maybeSingle();
      if (memberError) throw memberError;
      if (!member) return socket.emit("message-error", { error: "Not a group member" });

      const { data: saved, error } = await supabase.from("group_messages")
        .insert({ group_id: groupId, sender_id: senderId, message, message_type: "text" })
        .select("*").single();
      if (error) throw error;

      io.to(`group:${groupId}`).emit("group-message", saved);
    } catch (error) {
      console.error("GROUP MESSAGE:", error);
      socket.emit("message-error", { error: "Group message failed" });
    }
  });

  socket.on("disconnect", async () => {
    try {
      if (socket.userId) {
        const current = onlineUsers.get(socket.userId);
        // Avoid marking a newer connection offline when an old tab disconnects.
        if (current && current.socketId === socket.id) {
          onlineUsers.delete(socket.userId);
          await supabase.from("users")
            .update({ last_seen: new Date().toISOString() })
            .eq("id", Number(socket.userId));
        }
      }
      io.emit("online-users", Array.from(onlineUsers.keys()));
      console.log("Socket disconnected:", socket.id);
    } catch (error) {
      console.error("DISCONNECT:", error);
    }
  });
});

/* FALLBACK */

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`RealTimeChat running on port ${PORT}`);
});
