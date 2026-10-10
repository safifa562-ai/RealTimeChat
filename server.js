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

/* =========================================================
   SUPABASE
========================================================= */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET =
  process.env.JWT_SECRET;

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !JWT_SECRET
) {
  console.error(
    "Missing Supabase/JWT environment variables"
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

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/* =========================================================
   EDIT MESSAGE (sender only, within 15 minutes)
   Requires messages.is_edited boolean default false.
========================================================= */
app.patch("/api/messages/:id/edit", authMiddleware, async (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const text = String(req.body.message || "").trim();
    if (!Number.isInteger(messageId) || messageId < 1 || !text || text.length > 4000) {
      return res.status(400).json({ error: "Message must be 1–4000 characters." });
    }

    const { data: existing, error: readError } = await supabase
      .from("messages")
      .select("id,sender_id,receiver_id,message,message_type,created_at,is_deleted")
      .eq("id", messageId)
      .maybeSingle();

    if (readError || !existing) return res.status(404).json({ error: "Message not found." });
    if (Number(existing.sender_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You can only edit your own messages." });
    }
    if (existing.is_deleted) return res.status(400).json({ error: "Deleted messages cannot be edited." });
    if (existing.message_type && existing.message_type !== "text") {
      return res.status(400).json({ error: "Only text messages can be edited." });
    }
    const createdAt = new Date(existing.created_at).getTime();
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 15 * 60 * 1000 || Date.now() < createdAt) {
      return res.status(400).json({ error: "Messages can only be edited within 15 minutes." });
    }

    const { data: updated, error: updateError } = await supabase
      .from("messages")
      .update({ message: text, is_edited: true })
      .eq("id", messageId)
      .select("*")
      .single();

    if (updateError) {
      console.error("EDIT MESSAGE:", updateError);
      return res.status(500).json({ error: "Could not edit message. Check the SQL migration was run." });
    }

    io.emit("message-edited", updated);
    res.json({ success: true, message: updated });
  } catch (error) {
    console.error("EDIT MESSAGE ERROR:", error);
    res.status(500).json({ error: "Edit failed." });
  }
});

/* =========================================================
   FILE UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize:
      100 * 1024 * 1024
  }
});

/* =========================================================
   AUTH
========================================================= */

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

function authMiddleware(
  req,
  res,
  next
) {
  try {
    const header =
      req.headers.authorization || "";

    if (
      !header.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        error:
          "Authentication required"
      });
    }

    const token =
      header.substring(7);

    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    req.user = decoded;

    next();

  } catch (error) {
    return res.status(401).json({
      error:
        "Invalid or expired token"
    });
  }
}

/* =========================================================
   REGISTER
========================================================= */

app.post(
  "/api/register",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ""
        );

      if (
        !username ||
        !password
      ) {
        return res.status(400).json({
          error:
            "Username and password are required"
        });
      }

      if (
        username.length < 3
      ) {
        return res.status(400).json({
          error:
            "Username must be at least 3 characters"
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          error:
            "Password must be at least 6 characters"
        });
      }

      const {
        data: existing,
        error: existingError
      } = await supabase
        .from("users")
        .select("id")
        .eq(
          "username",
          username
        )
        .maybeSingle();

      if (existingError) {

        console.error(
          "REGISTER CHECK:",
          existingError
        );

        return res.status(500).json({
          error:
            "Database error"
        });
      }

      if (existing) {
        return res.status(409).json({
          error:
            "Username already exists"
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const {
        data: user,
        error
      } = await supabase
        .from("users")
        .insert({
          username,
          password_hash:
            passwordHash
        })
        .select(
          "id, username, avatar_url, created_at"
        )
        .single();

      if (error) {

        console.error(
          "REGISTER:",
          error
        );

        return res.status(500).json({
          error:
            "Registration failed"
        });
      }

      const token =
        createToken(user);

      res.status(201).json({
        message:
          "Account created",
        token,
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

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    try {

      const username =
        String(
          req.body.username || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body.password || ""
        );

      const {
        data: user,
        error
      } = await supabase
        .from("users")
        .select(
          "id, username, password_hash, avatar_url, created_at"
        )
        .eq(
          "username",
          username
        )
        .maybeSingle();

      if (error) {

        console.error(
          "LOGIN DB:",
          error
        );

        return res.status(500).json({
          error:
            "Database error"
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
        .eq(
          "id",
          user.id
        );

      delete user.password_hash;

      const token =
        createToken(user);

      res.json({
        message:
          "Login successful",
        token,
        user
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

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/me",
  authMiddleware,
  async (req, res) => {

    try {

      const {
        data,
        error
      } = await supabase
        .from("users")
        .select(
          "id, username, avatar_url, created_at, last_seen"
        )
        .eq(
          "id",
          req.user.id
        )
        .single();

      if (error) {

        console.error(
          "ME:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load profile"
        });
      }

      res.json(data);

    } catch (error) {

      console.error(
        "ME ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Could not load profile"
      });
    }
  }
);

/* =========================================================
   USERS
========================================================= */

app.get(
  "/api/users",
  authMiddleware,
  async (req, res) => {

    try {

      const search =
        String(
          req.query.search || ""
        )
          .trim()
          .toLowerCase();

      let query =
        supabase
          .from("users")
          .select(
            "id, username, avatar_url, last_seen, created_at"
          )
          .neq(
            "id",
            req.user.id
          )
          .order(
            "username",
            {
              ascending: true
            }
          )
          .limit(100);

      if (search) {

        query =
          query.ilike(
            "username",
            `%${search}%`
          );
      }

      const {
        data,
        error
      } = await query;

      if (error) {

        console.error(
          "USERS:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load users"
        });
      }

      const users =
        (data || []).map(
          user => ({
            ...user,

            online:
              onlineUsers.has(
                String(user.id)
              )
          })
        );

      res.json(users);

    } catch (error) {

      console.error(
        "USERS ERROR:",
        error
      );

      res.status(500).json({
        error:
          "User search failed"
      });
    }
  }
);

/* =========================================================
   FRIENDS
========================================================= */

app.post("/api/friends/request", authMiddleware, async (req,res)=>{
  try{
    const receiverId=Number(req.body.receiverId);
    const senderId=Number(req.user.id);
    if(!Number.isInteger(receiverId) || receiverId<=0 || receiverId===senderId)
      return res.status(400).json({error:"Invalid receiver"});

    const {data:receiver,error:receiverError}=await supabase.from("users").select("id,username").eq("id",receiverId).maybeSingle();
    if(receiverError) return res.status(500).json({error:"Database error"});
    if(!receiver) return res.status(404).json({error:"User not found"});

    const {data:existingFriend}=await supabase.from("friendships").select("id").eq("user_id",senderId).eq("friend_id",receiverId).maybeSingle();
    if(existingFriend) return res.status(409).json({error:"Already friends"});

    const {data:reverseFriend}=await supabase.from("friendships").select("id").eq("user_id",receiverId).eq("friend_id",senderId).maybeSingle();
    if(reverseFriend) return res.status(409).json({error:"Already friends"});

    const {data:existing}=await supabase.from("friend_requests").select("id,sender_id,receiver_id,status").or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`).in("status",["pending"]).maybeSingle();
    if(existing) return res.status(409).json({error:"Friend request already pending"});

    const {data:request,error}=await supabase.from("friend_requests").insert({sender_id:senderId,receiver_id:receiverId,status:"pending"}).select("*").single();
    if(error) return res.status(500).json({error:"Could not send friend request"});

    const notifyReceiver=onlineUsers.get(String(receiverId));
    if(notifyReceiver) io.to(notifyReceiver.socketId).emit("friend-request",request);
    res.status(201).json(request);
  }catch(error){ console.error("FRIEND REQUEST:",error); res.status(500).json({error:"Friend request failed"}); }
});

app.get("/api/friends/requests", authMiddleware, async (req,res)=>{
  try{
    const {data:requests,error}=await supabase.from("friend_requests").select("*").eq("receiver_id",Number(req.user.id)).eq("status","pending").order("created_at",{ascending:false});
    if(error) return res.status(500).json({error:"Could not load requests"});
    const ids=[...(requests||[]).map(r=>r.sender_id)];
    let users=[];
    if(ids.length){ const q=await supabase.from("users").select("id,username,avatar_url,last_seen").in("id",ids); users=q.data||[]; }
    const map=new Map(users.map(u=>[Number(u.id),u]));
    res.json((requests||[]).map(r=>({...r,sender:map.get(Number(r.sender_id))||null})));
  }catch(error){ console.error("REQUESTS:",error); res.status(500).json({error:"Could not load requests"}); }
});

app.post("/api/friends/respond", authMiddleware, async (req,res)=>{
  try{
    const requestId=Number(req.body.requestId);
    const action=String(req.body.action||"").toLowerCase();
    if(!Number.isInteger(requestId) || !["accept","reject"].includes(action)) return res.status(400).json({error:"Invalid request"});

    const {data:request,error}=await supabase.from("friend_requests").select("*").eq("id",requestId).eq("receiver_id",Number(req.user.id)).eq("status","pending").maybeSingle();
    if(error) return res.status(500).json({error:"Database error"});
    if(!request) return res.status(404).json({error:"Request not found"});

    const newStatus=action==="accept"?"accepted":"rejected";
    const {error:updateError}=await supabase.from("friend_requests").update({status:newStatus}).eq("id",requestId);
    if(updateError) return res.status(500).json({error:"Could not update request"});

    if(action==="accept"){
      const rows=[{user_id:Number(req.user.id),friend_id:Number(request.sender_id),status:"accepted"},{user_id:Number(request.sender_id),friend_id:Number(req.user.id),status:"accepted"}];
      const {error:friendError}=await supabase.from("friendships").upsert(rows,{onConflict:"user_id,friend_id",ignoreDuplicates:true});
      if(friendError) return res.status(500).json({error:"Could not create friendship"});
      const sender=onlineUsers.get(String(request.sender_id));
      if(sender) io.to(sender.socketId).emit("friend-accepted",{userId:Number(req.user.id)});
    } else {
      const sender=onlineUsers.get(String(request.sender_id));
      if(sender) io.to(sender.socketId).emit("friend-request-rejected",{userId:Number(req.user.id)});
    }
    res.json({success:true,status:newStatus});
  }catch(error){ console.error("FRIEND RESPOND:",error); res.status(500).json({error:"Request update failed"}); }
});

app.get("/api/friends", authMiddleware, async (req,res)=>{
  try{
    const {data:rows,error}=await supabase.from("friendships").select("friend_id").eq("user_id",Number(req.user.id));
    if(error) return res.status(500).json({error:"Could not load friends"});
    const ids=(rows||[]).map(r=>Number(r.friend_id));
    if(!ids.length) return res.json([]);
    const {data:users,error:userError}=await supabase.from("users").select("id,username,avatar_url,last_seen,created_at").in("id",ids).order("username",{ascending:true});
    if(userError) return res.status(500).json({error:"Could not load friends"});
    res.json((users||[]).map(u=>({...u,online:onlineUsers.has(String(u.id))})));
  }catch(error){ console.error("FRIENDS:",error); res.status(500).json({error:"Could not load friends"}); }
});

app.delete("/api/friends/:friendId", authMiddleware, async (req,res)=>{
  try{
    const friendId=Number(req.params.friendId), userId=Number(req.user.id);
    if(!Number.isInteger(friendId) || friendId===userId) return res.status(400).json({error:"Invalid friend"});
    await supabase.from("friendships").delete().eq("user_id",userId).eq("friend_id",friendId);
    await supabase.from("friendships").delete().eq("user_id",friendId).eq("friend_id",userId);
    const receiver=onlineUsers.get(String(friendId));
    if(receiver) io.to(receiver.socketId).emit("friend-removed",{userId});
    res.json({success:true});
  }catch(error){ console.error("REMOVE FRIEND:",error); res.status(500).json({error:"Could not remove friend"}); }
});

/* =========================================================
   MESSAGE SEARCH
========================================================= */
app.get("/api/messages/search", authMiddleware, async (req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const otherId=Number(req.query.userId);
    const me=Number(req.user.id);
    if(!q || !Number.isInteger(otherId)) return res.json([]);
    const {data,error}=await supabase.from("messages").select("*").or(`and(sender_id.eq.${me},receiver_id.eq.${otherId}),and(sender_id.eq.${otherId},receiver_id.eq.${me})`).ilike("message",`%${q}%`).eq("is_deleted",false).order("created_at",{ascending:false}).limit(100);
    if(error) return res.status(500).json({error:"Search failed"});
    res.json(data||[]);
  }catch(error){ console.error("MESSAGE SEARCH:",error); res.status(500).json({error:"Search failed"}); }
});

/* =========================================================
   REACTIONS
========================================================= */
app.get("/api/messages/:messageId/reactions", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId);
    const {data,error}=await supabase.from("message_reactions").select("id,message_id,user_id,emoji").eq("message_id",messageId);
    if(error) return res.status(500).json({error:"Could not load reactions"});
    res.json(data||[]);
  }catch(error){ res.status(500).json({error:"Could not load reactions"}); }
});

app.post("/api/messages/:messageId/reactions", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId), emoji=String(req.body.emoji||"").trim();
    if(!Number.isInteger(messageId)||!emoji||emoji.length>16) return res.status(400).json({error:"Invalid reaction"});
    const {data,error}=await supabase.from("message_reactions").upsert({message_id:messageId,user_id:Number(req.user.id),emoji},{onConflict:"message_id,user_id,emoji"}).select("*").single();
    if(error) return res.status(500).json({error:"Could not add reaction"});
    const {data:message}=await supabase.from("messages").select("sender_id,receiver_id").eq("id",messageId).maybeSingle();
    if(message){ for(const id of [message.sender_id,message.receiver_id]){ const u=onlineUsers.get(String(id)); if(u) io.to(u.socketId).emit("reaction-updated",{messageId}); } }
    res.json(data);
  }catch(error){ console.error("REACTION ADD:",error); res.status(500).json({error:"Reaction failed"}); }
});

app.delete("/api/messages/:messageId/reactions/:emoji", authMiddleware, async (req,res)=>{
  try{
    const messageId=Number(req.params.messageId), emoji=String(req.params.emoji||"");
    await supabase.from("message_reactions").delete().eq("message_id",messageId).eq("user_id",Number(req.user.id)).eq("emoji",emoji);
    res.json({success:true});
  }catch(error){ res.status(500).json({error:"Could not remove reaction"}); }
});

/* =========================================================
   GROUPS
========================================================= */
app.get("/api/groups", authMiddleware, async (req,res)=>{
  try{
    const {data:members,error}=await supabase.from("group_members").select("group_id").eq("user_id",Number(req.user.id));
    if(error) return res.status(500).json({error:"Could not load groups"});
    const ids=(members||[]).map(m=>m.group_id); if(!ids.length) return res.json([]);
    const {data:groups,error:groupError}=await supabase.from("groups").select("*").in("id",ids).order("created_at",{ascending:false});
    if(groupError) return res.status(500).json({error:"Could not load groups"});
    res.json(groups||[]);
  }catch(error){res.status(500).json({error:"Could not load groups"});}
});

app.post("/api/groups", authMiddleware, async (req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name || name.length>80) return res.status(400).json({error:"Enter a valid group name"});
    const creatorId=Number(req.user.id);
    const {data:group,error}=await supabase.from("groups").insert({name,created_by:creatorId}).select("*").single();
    if(error) return res.status(500).json({error:"Could not create group"});
    const {error:memberError}=await supabase.from("group_members").insert({group_id:group.id,user_id:creatorId});
    if(memberError) return res.status(500).json({error:"Could not add creator"});
    res.status(201).json(group);
  }catch(error){res.status(500).json({error:"Group creation failed"});}
});

app.post("/api/groups/:groupId/members", authMiddleware, async (req,res)=>{
  try{
    const groupId=Number(req.params.groupId), userId=Number(req.body.userId), me=Number(req.user.id);
    if(!Number.isInteger(groupId)||!Number.isInteger(userId)) return res.status(400).json({error:"Invalid group/member"});
    const {data:creator}=await supabase.from("groups").select("created_by").eq("id",groupId).maybeSingle();
    if(!creator || Number(creator.created_by)!==me) return res.status(403).json({error:"Only group creator can add members"});
    const {error}=await supabase.from("group_members").upsert({group_id:groupId,user_id:userId},{onConflict:"group_id,user_id",ignoreDuplicates:true});
    if(error) return res.status(500).json({error:"Could not add member"});
    res.json({success:true});
  }catch(error){res.status(500).json({error:"Could not add member"});}
});

app.get("/api/groups/:groupId/messages", authMiddleware, async (req,res)=>{
  try{
    const groupId=Number(req.params.groupId), userId=Number(req.user.id);
    const {data:member}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",userId).maybeSingle();
    if(!member) return res.status(403).json({error:"Not a group member"});
    const {data,error}=await supabase.from("group_messages").select("*").eq("group_id",groupId).order("created_at",{ascending:true}).limit(500);
    if(error) return res.status(500).json({error:"Could not load group history"});
    res.json(data||[]);
  }catch(error){res.status(500).json({error:"Group history failed"});}
});

/* =========================================================
   CHAT HISTORY
========================================================= */

app.get(
  "/api/messages/:userId/:otherUserId",
  authMiddleware,
  async (req, res) => {

    try {

      const userId =
        Number(
          req.params.userId
        );

      const otherUserId =
        Number(
          req.params.otherUserId
        );

      if (
        userId !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error:
            "Access denied"
        });
      }

      const {
        data,
        error
      } = await supabase
        .from("messages")
        .select("*")
        .or(
          `and(sender_id.eq.${userId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${userId})`
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        )
        .limit(500);

      if (error) {

        console.error(
          "HISTORY:",
          error
        );

        return res.status(500).json({
          error:
            "Could not load chat history"
        });
      }

      res.json(
        data || []
      );

    } catch (error) {

      console.error(
        "HISTORY ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Chat history failed"
      });
    }
  }
);

/* =========================================================
   DELETE MESSAGE
========================================================= */

app.delete(
  "/api/messages/:id",
  authMiddleware,
  async (req, res) => {

    try {

      const messageId =
        Number(
          req.params.id
        );

      const {
        data: message,
        error
      } = await supabase
        .from("messages")
        .select(
          "id, sender_id"
        )
        .eq(
          "id",
          messageId
        )
        .single();

      if (
        error ||
        !message
      ) {
        return res.status(404).json({
          error:
            "Message not found"
        });
      }

      if (
        Number(
          message.sender_id
        ) !==
        Number(req.user.id)
      ) {
        return res.status(403).json({
          error:
            "You can only delete your own messages"
        });
      }

      const {
        error: deleteError
      } = await supabase
        .from("messages")
        .update({
          is_deleted:
            true,
          message:
            null,
          file_name:
            null,
          file_url:
            null
        })
        .eq(
          "id",
          messageId
        );

      if (deleteError) {

        console.error(
          "DELETE:",
          deleteError
        );

        return res.status(500).json({
          error:
            "Could not delete message"
        });
      }

      io.emit(
        "message-deleted",
        {
          id:
            messageId
        }
      );

      res.json({
        success:
          true
      });

    } catch (error) {

      console.error(
        "DELETE ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Delete failed"
      });
    }
  }
);

/* =========================================================
   FILE UPLOAD
========================================================= */

app.post(
  "/api/upload",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error:
            "No file selected"
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

      const {
        error
      } = await supabase.storage
        .from("chat-files")
        .upload(
          filePath,
          req.file.buffer,
          {
            contentType:
              req.file.mimetype,
            upsert:
              false
          }
        );

      if (error) {

        console.error(
          "STORAGE:",
          error
        );

        return res.status(500).json({
          error:
            "File upload failed. Check chat-files bucket."
        });
      }

      const {
        data
      } =
        supabase.storage
          .from("chat-files")
          .getPublicUrl(
            filePath
          );

      res.json({
        success:
          true,

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

      console.error(
        "UPLOAD ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Upload failed"
      });
    }
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  async (req, res) => {

    try {

      const {
        error
      } = await supabase
        .from("users")
        .select("id")
        .limit(1);

      res.json({
        status:
          "ok",

        database:
          error
            ? "error"
            : "connected",

        socket:
          "enabled",

        storage:
          "enabled",

        webrtc:
          "enabled"
      });

    } catch (error) {

      console.error(
        "HEALTH:",
        error
      );

      res.status(500).json({
        status:
          "error",

        database:
          "error",

        socket:
          "enabled",

        storage:
          "enabled",

        webrtc:
          "enabled"
      });
    }
  }
);

/* =========================================================
   ONLINE USERS
========================================================= */

const onlineUsers =
  new Map();

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  "connection",
  socket => {

    console.log(
      "Socket connected:",
      socket.id
    );

    /* =====================================================
       USER ONLINE
    ===================================================== */

    socket.on(
      "user-online",
      async user => {

        try {

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
                new Date().toISOString()
            })
            .eq(
              "id",
              user.id
            );

          io.emit(
            "online-users",
            Array.from(
              onlineUsers.keys()
            )
          );

          console.log(
            "ONLINE:",
            user.username
          );

        } catch (error) {

          console.error(
            "ONLINE ERROR:",
            error
          );
        }
      }
    );

    /* =====================================================
       PRIVATE MESSAGE
       IMPORTANT: THIS IS INSIDE io.on("connection")
    ===================================================== */

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

          /* Security check */

          if (
            senderId !==
            Number(socket.userId)
          ) {
            console.log(
              "Unauthorized message attempt"
            );

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
              message ||
              null,

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
              "MESSAGE DB ERROR:",
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

          /* Send to receiver */

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

          /* Send back to sender */

          socket.emit(
            "private-message",
            saved
          );

        } catch (error) {

          console.error(
            "PRIVATE MESSAGE ERROR:",
            error
          );

          socket.emit(
            "message-error",
            {
              error:
                "Message failed"
            }
          );
        }
      }
    );

    /* =====================================================
       TYPING
    ===================================================== */

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

    /* =====================================================
       READ RECEIPTS
    ===================================================== */

    socket.on(
      "messages-read",
      async data => {

        try {

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

        } catch (error) {

          console.error(
            "READ ERROR:",
            error
          );
        }
      }
    );

    /* =====================================================
       START CALL
    ===================================================== */

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

    /* =====================================================
       CALL OFFER
    ===================================================== */

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

    /* =====================================================
       CALL ANSWER
    ===================================================== */

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

    /* =====================================================
       ICE CANDIDATE
    ===================================================== */

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

    /* =====================================================
       END CALL
    ===================================================== */

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

    /* =====================================================
       SCREEN SHARE
    ===================================================== */

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

    /* =====================================================
       CALL TRANSFER
    ===================================================== */

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

    /* =====================================================
       GROUP CHAT
    ===================================================== */
    socket.on("join-group", async data=>{
      try{
        const groupId=Number(data.groupId), userId=Number(socket.userId);
        const {data:member}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",userId).maybeSingle();
        if(member) socket.join(`group:${groupId}`);
      }catch(error){ console.error("JOIN GROUP:",error); }
    });

    socket.on("group-message", async data=>{
      try{
        const groupId=Number(data.groupId), senderId=Number(socket.userId);
        const {data:member}=await supabase.from("group_members").select("id").eq("group_id",groupId).eq("user_id",senderId).maybeSingle();
        if(!member) return socket.emit("message-error",{error:"You are not a group member"});
        const message=String(data.message||"").trim();
        if(!message) return;
        const {data:saved,error}=await supabase.from("group_messages").insert({group_id:groupId,sender_id:senderId,message,message_type:"text"}).select("*").single();
        if(error) return socket.emit("message-error",{error:"Group message failed"});
        io.to(`group:${groupId}`).emit("group-message",saved);
      }catch(error){console.error("GROUP MESSAGE:",error);}
    });

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      "disconnect",
      async () => {

        try {

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
                  new Date().toISOString()
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

        } catch (error) {

          console.error(
            "DISCONNECT ERROR:",
            error
          );
        }
      }
    );
  }
);

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

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

/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `RealTimeChat running on port ${PORT}`
    );
  }
);
