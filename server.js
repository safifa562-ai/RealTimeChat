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
    methods: ["GET", "POST", "DELETE"]
  }
});

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !JWT_SECRET
) {
  console.error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or JWT_SECRET"
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const onlineUsers = new Map();

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

function authMiddleware(req, res, next) {
  try {
    const header =
      req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    const token = header.substring(7);

    req.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();
  } catch {
    res.status(401).json({
      error: "Invalid or expired token"
    });
  }
}

/* =====================================================
   REGISTER
===================================================== */

app.post("/api/register", async (req, res) => {
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

    const { data: existing, error } =
      await supabase
        .from("users")
        .select("id")
        .eq("username", username)
        .maybeSingle();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Database error"
      });
    }

    if (existing) {
      return res.status(409).json({
        error:
          "Username already exists"
      });
    }

    const passwordHash =
      await bcrypt.hash(password, 12);

    const { data: user, error: insertError } =
      await supabase
        .from("users")
        .insert({
          username,
          password_hash: passwordHash
        })
        .select(
          "id, username, avatar_url, created_at"
        )
        .single();

    if (insertError) {
      console.error(insertError);

      return res.status(500).json({
        error: "Registration failed"
      });
    }

    res.status(201).json({
      message: "Account created",
      token: createToken(user),
      user
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* =====================================================
   LOGIN
===================================================== */

app.post("/api/login", async (req, res) => {
  try {
    const username = String(
      req.body.username || ""
    )
      .trim()
      .toLowerCase();

    const password = String(
      req.body.password || ""
    );

    const { data: user, error } =
      await supabase
        .from("users")
        .select("*")
        .eq("username", username)
        .maybeSingle();

    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Database error"
      });
    }

    if (!user) {
      return res.status(401).json({
        error:
          "Invalid username or password"
      });
    }

    const valid =
      await bcrypt.compare(
        password,
        user.password_hash
      );

    if (!valid) {
      return res.status(401).json({
        error:
          "Invalid username or password"
      });
    }

    await supabase
      .from("users")
      .update({
        last_seen:
          new Date().toISOString()
      })
      .eq("id", user.id);

    delete user.password_hash;

    res.json({
      message: "Login successful",
      token: createToken(user),
      user
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

/* =====================================================
   CURRENT USER
===================================================== */

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {
    const { data, error } =
      await supabase
        .from("users")
        .select(
          "id, username, avatar_url, created_at, last_seen"
        )
        .eq("id", req.user.id)
        .single();

    if (error) {
      return res.status(500).json({
        error: "Could not load profile"
      });
    }

    res.json(data);
  }
);

/* =====================================================
   USERS
===================================================== */

app.get(
  "/api/users",
  authMiddleware,
  async (req, res) => {
    try {
      const search = String(
        req.query.search || ""
      )
        .trim()
        .toLowerCase();

      let query = supabase
        .from("users")
        .select(
          "id, username, avatar_url, last_seen, created_at"
        )
        .neq("id", req.user.id)
        .order("username", {
          ascending: true
        })
        .limit(100);

      if (search) {
        query = query.ilike(
          "username",
          `%${search}%`
        );
      }

      const { data, error } = await query;

      if (error) {
        console.error(error);

        return res.status(500).json({
          error: "Could not load users"
        });
      }

      res.json(
        (data || []).map(user => ({
          ...user,
          online:
            onlineUsers.has(
              String(user.id)
            )
        }))
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "User search failed"
      });
    }
  }
);

/* =====================================================
   CHAT HISTORY
===================================================== */

app.get(
  "/api/messages/:userId/:otherUserId",
  authMiddleware,
  async (req, res) => {
    try {
      const userId =
        Number(req.params.userId);

      const otherUserId =
        Number(req.params.otherUserId);

      if (
        userId !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error: "Access denied"
        });
      }

      const { data, error } =
        await supabase
          .from("messages")
          .select("*")
          .or(
            `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
          )
          .order("created_at", {
            ascending: true
          })
          .limit(500);

      if (error) {
        console.error(error);

        return res.status(500).json({
          error:
            "Could not load chat history"
        });
      }

      res.json(data || []);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Chat history failed"
      });
    }
  }
);

/* =====================================================
   DELETE MESSAGE
===================================================== */

app.delete(
  "/api/messages/:id",
  authMiddleware,
  async (req, res) => {
    try {
      const messageId =
        Number(req.params.id);

      const { data: message } =
        await supabase
          .from("messages")
          .select(
            "id, sender_id"
          )
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
          error:
            "You can only delete your own message"
        });
      }

      const { error } =
        await supabase
          .from("messages")
          .update({
            is_deleted: true,
            message: null,
            file_name: null,
            file_url: null
          })
          .eq("id", messageId);

      if (error) {
        return res.status(500).json({
          error:
            "Could not delete message"
        });
      }

      io.emit(
        "message-deleted",
        {
          id: messageId
        }
      );

      res.json({
        success: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Delete failed"
      });
    }
  }
);

/* =====================================================
   FILE UPLOAD
===================================================== */

app.post(
  "/api/upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No file selected"
        });
      }

      const safeName =
        req.file.originalname
          .replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

      const filePath =
        `${req.user.id}/${Date.now()}-${safeName}`;

      const { error } =
        await supabase.storage
          .from("chat-files")
          .upload(
            filePath,
            req.file.buffer,
            {
              contentType:
                req.file.mimetype,
              upsert: false
            }
          );

      if (error) {
        console.error(error);

        return res.status(500).json({
          error:
            "File upload failed. Check chat-files bucket."
        });
      }

      const { data } =
        supabase.storage
          .from("chat-files")
          .getPublicUrl(
            filePath
          );

      res.json({
        success: true,
        file: {
          name:
            req.file.originalname,
          size:
            req.file.size,
          type:
            req.file.mimetype,
          path:
            filePath,
          url:
            data.publicUrl
        }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Upload failed"
      });
    }
  }
);

/* =====================================================
   FRIEND REQUEST — SEND
===================================================== */

app.post(
  "/api/friends/request",
  authMiddleware,
  async (req, res) => {
    try {
      const receiverId =
        Number(req.body.receiverId);

      if (!receiverId) {
        return res.status(400).json({
          error:
            "Receiver ID required"
        });
      }

      if (
        receiverId ===
        Number(req.user.id)
      ) {
        return res.status(400).json({
          error:
            "You cannot add yourself"
        });
      }

      const { data: existing } =
        await supabase
          .from("friend_requests")
          .select(
            "id, status"
          )
          .eq(
            "sender_id",
            req.user.id
          )
          .eq(
            "receiver_id",
            receiverId
          )
          .maybeSingle();

      if (existing) {
        return res.status(409).json({
          error:
            "Friend request already exists"
        });
      }

      const { data: friendship } =
        await supabase
          .from("friendships")
          .select("id")
          .eq(
            "user_id",
            req.user.id
          )
          .eq(
            "friend_id",
            receiverId
          )
          .maybeSingle();

      if (friendship) {
        return res.status(409).json({
          error:
            "Already friends"
        });
      }

      const { data, error } =
        await supabase
          .from("friend_requests")
          .insert({
            sender_id:
              req.user.id,
            receiver_id:
              receiverId,
            status:
              "pending"
          })
          .select("*")
          .single();

      if (error) {
        console.error(error);

        return res.status(500).json({
          error:
            "Could not send request"
        });
      }

      const receiver =
        onlineUsers.get(
          String(receiverId)
        );

      if (receiver) {
        io.to(
          receiver.socketId
        ).emit(
          "friend-request",
          data
        );
      }

      res.json({
        success: true,
        request: data
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Friend request failed"
      });
    }
  }
);

/* =====================================================
   FRIEND REQUESTS — INCOMING
===================================================== */

app.get(
  "/api/friends/requests",
  authMiddleware,
  async (req, res) => {
    try {
      const { data, error } =
        await supabase
          .from("friend_requests")
          .select("*")
          .eq(
            "receiver_id",
            req.user.id
          )
          .eq(
            "status",
            "pending"
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          );

      if (error) {
        console.error(error);

        return res.status(500).json({
          error:
            "Could not load requests"
        });
      }

      res.json(data || []);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Request loading failed"
      });
    }
  }
);

/* =====================================================
   FRIEND REQUEST — ACCEPT / REJECT
===================================================== */

app.post(
  "/api/friends/respond",
  authMiddleware,
  async (req, res) => {
    try {
      const requestId =
        Number(req.body.requestId);

      const action =
        String(
          req.body.action || ""
        );

      if (
        !requestId ||
        ![
          "accept",
          "reject"
        ].includes(action)
      ) {
        return res.status(400).json({
          error:
            "Invalid request"
        });
      }

      const { data: request } =
        await supabase
          .from("friend_requests")
          .select("*")
          .eq(
            "id",
            requestId
          )
          .eq(
            "receiver_id",
            req.user.id
          )
          .eq(
            "status",
            "pending"
          )
          .maybeSingle();

      if (!request) {
        return res.status(404).json({
          error:
            "Request not found"
        });
      }

      if (action === "reject") {
        await supabase
          .from("friend_requests")
          .update({
            status:
              "rejected"
          })
          .eq(
            "id",
            requestId
          );

        return res.json({
          success: true,
          action:
            "rejected"
        });
      }

      await supabase
        .from("friend_requests")
        .update({
          status:
            "accepted"
        })
        .eq(
          "id",
          requestId
        );

      const { error } =
        await supabase
          .from("friendships")
          .upsert([
            {
              user_id:
                request.sender_id,
              friend_id:
                request.receiver_id,
              status:
                "accepted"
            },
            {
              user_id:
                request.receiver_id,
              friend_id:
                request.sender_id,
              status:
                "accepted"
            }
          ]);

      if (error) {
        console.error(error);

        return res.status(500).json({
          error:
            "Could not create friendship"
        });
      }

      const sender =
        onlineUsers.get(
          String(request.sender_id)
        );

      if (sender) {
        io.to(
          sender.socketId
        ).emit(
          "friend-accepted",
          {
            userId:
              req.user.id
          }
        );
      }

      res.json({
        success: true,
        action:
          "accepted"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Friend response failed"
      });
    }
  }
);

/* =====================================================
   FRIENDS LIST
===================================================== */

app.get(
  "/api/friends",
  authMiddleware,
  async (req, res) => {
    try {
      const { data, error } =
        await supabase
          .from("friendships")
          .select(
            "friend_id, status"
          )
          .eq(
            "user_id",
            req.user.id
          )
          .eq(
            "status",
            "accepted"
          );

      if (error) {
        return res.status(500).json({
          error:
            "Could not load friends"
        });
      }

      const ids =
        (data || []).map(
          x => x.friend_id
        );

      if (!ids.length) {
        return res.json([]);
      }

      const { data: friends } =
        await supabase
          .from("users")
          .select(
            "id, username, avatar_url, last_seen"
          )
          .in(
            "id",
            ids
          );

      res.json(
        (friends || []).map(
          friend => ({
            ...friend,
            online:
              onlineUsers.has(
                String(friend.id)
              )
          })
        )
      );

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Friends loading failed"
      });
    }
  }
);

/* =====================================================
   HEALTH
===================================================== */

app.get("/health", async (req, res) => {
  try {
    const { error } =
      await supabase
        .from("users")
        .select("id")
        .limit(1);

    res.json({
      status: "ok",
      database:
        error
          ? "error"
          : "connected",
      socket:
        "enabled",
      storage:
        "enabled",
      webrtc:
        "enabled",
      friends:
        "enabled"
    });

  } catch {
    res.status(500).json({
      status:
        "error"
    });
  }
});

/* =====================================================
   SOCKET.IO
===================================================== */

io.on(
  "connection",
  socket => {

    console.log(
      "Socket connected:",
      socket.id
    );

    /* ---------- ONLINE ---------- */

    socket.on(
      "user-online",
      async user => {

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

        await supabase
          .from("users")
          .update({
            last_seen:
              new Date()
                .toISOString()
          })
          .eq(
            "id",
            Number(user.id)
          );

        io.emit(
          "online-users",
          Array.from(
            onlineUsers.keys()
          )
        );
      }
    );

    /* ---------- PRIVATE MESSAGE ---------- */

    socket.on(
      "private-message",
      async data => {

        try {

          const senderId =
            Number(
              data.senderId
            );

          const receiverId =
            Number(
              data.receiverId
            );

          if (
            !senderId ||
            !receiverId
          ) {
            return;
          }

          if (
            senderId !==
            Number(socket.userId)
          ) {
            return;
          }

          const messageType =
            data.messageType ===
            "file"
              ? "file"
              : "text";

          const message =
            String(
              data.message || ""
            ).trim();

          if (
            messageType ===
              "text" &&
            !message
          ) {
            return;
          }

          const insertData = {
            sender_id:
              senderId,

            receiver_id:
              receiverId,

            message:
              message || null,

            message_type:
              messageType,

            file_name:
              data.fileName ||
              null,

            file_url:
              data.fileUrl ||
              null,

            file_size:
              data.fileSize
                ? Number(
                    data.fileSize
                  )
                : null
          };

          const {
            data: saved,
            error
          } = await supabase
            .from("messages")
            .insert(
              insertData
            )
            .select("*")
            .single();

          if (error) {
            console.error(
              "MESSAGE DB:",
              error
            );

            socket.emit(
              "message-error",
              {
                error:
                  "Message could not be saved"
              }
            );

            return;
          }

          const receiver =
            onlineUsers.get(
              String(
                receiverId
              )
            );

          if (receiver) {
            io.to(
              receiver.socketId
            ).emit(
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
            error
          );
        }
      }
    );

    /* ---------- TYPING ---------- */

    socket.on(
      "typing",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "typing",
          {
            senderId:
              socket.userId,

            typing:
              Boolean(
                data.typing
              )
          }
        );
      }
    );

    /* ---------- READ ---------- */

    socket.on(
      "messages-read",
      async data => {

        const senderId =
          Number(
            data.senderId
          );

        const receiverId =
          Number(
            socket.userId
          );

        await supabase
          .from("messages")
          .update({
            is_read:
              true
          })
          .eq(
            "sender_id",
            senderId
          )
          .eq(
            "receiver_id",
            receiverId
          )
          .eq(
            "is_read",
            false
          );

        const sender =
          onlineUsers.get(
            String(
              senderId
            )
          );

        if (sender) {
          io.to(
            sender.socketId
          ).emit(
            "messages-read",
            {
              byUserId:
                receiverId
            }
          );
        }
      }
    );

    /* ---------- FRIEND REQUEST ---------- */

    socket.on(
      "friend-request-notification",
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
            "friend-request",
            data
          );
        }
      }
    );

    /* ---------- AUDIO / VIDEO CALL ---------- */

    socket.on(
      "start-call",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {

          socket.emit(
            "call-error",
            {
              error:
                "User is offline"
            }
          );

          return;
        }

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
    );

    /* ---------- WEBRTC OFFER ---------- */

    socket.on(
      "call-offer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

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
    );

    /* ---------- WEBRTC ANSWER ---------- */

    socket.on(
      "call-answer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "call-answer",
          data
        );
      }
    );

    /* ---------- ICE ---------- */

    socket.on(
      "ice-candidate",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "ice-candidate",
          data
        );
      }
    );

    /* ---------- END CALL ---------- */

    socket.on(
      "end-call",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "end-call",
          data
        );
      }
    );

    /* ---------- SCREEN SHARE ---------- */

    socket.on(
      "screen-share",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.receiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "screen-share",
          data
        );
      }
    );

    /* ---------- CALL TRANSFER ---------- */

    socket.on(
      "call-transfer",
      data => {

        const receiver =
          onlineUsers.get(
            String(
              data.newReceiverId
            )
          );

        if (!receiver) {
          return;
        }

        io.to(
          receiver.socketId
        ).emit(
          "call-transfer",
          data
        );
      }
    );

    /* ---------- DISCONNECT ---------- */

    socket.on(
      "disconnect",
      async () => {

        if (
          socket.userId
        ) {

          onlineUsers.delete(
            socket.userId
          );

          await supabase
            .from("users")
            .update({
              last_seen:
                new Date()
                  .toISOString()
            })
            .eq(
              "id",
              Number(
                socket.userId
              )
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

/* =====================================================
   FRONTEND FALLBACK
===================================================== */

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

/* =====================================================
   START SERVER
===================================================== */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `RealTimeChat running on port ${PORT}`
    );
  }
);
