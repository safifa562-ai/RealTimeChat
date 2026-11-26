const multer = require("multer");
const crypto = require("crypto");

const POST_LIMIT = 50 * 1024 * 1024;
const POST_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"]);

function validPostMedia(file) {
  if (!file || !file.buffer || file.buffer.length < 12) return false;
  const type = String(file.mimetype || "").toLowerCase();
  const b = file.buffer;
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (type === "image/webp") return b.toString("ascii",0,4) === "RIFF" && b.toString("ascii",8,12) === "WEBP";
  if (type === "video/mp4") return b.toString("ascii",4,8) === "ftyp";
  if (type === "video/webm") return b.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  return false;
}

function registerSocialRoutes({ app, supabase, authMiddleware, io }) {
  async function areBlocked(userA, userB) {
    const a = Number(userA), b = Number(userB);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a === b) return false;
    const result = await supabase.from("user_blocks").select("blocker_id").or(
      `and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`
    ).limit(1);
    if (result.error) {
      if (["42P01","PGRST205","PGRST204"].includes(String(result.error.code || ""))) return false;
      throw result.error;
    }
    return Boolean(result.data && result.data.length);
  }

  const postUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: POST_LIMIT, files: 1 },
    fileFilter: (req, file, cb) => {
      if (!POST_TYPES.has(String(file.mimetype || "").toLowerCase())) {
        return cb(new Error("Choose a JPG, PNG, WebP, MP4 or WebM file."));
      }
      cb(null, true);
    }
  });

  function uploadPostMedia(req, res, next) {
    postUpload.single("media")(req, res, error => {
      if (!error) return next();
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: error.code === "LIMIT_FILE_SIZE"
          ? "A post must be 50 MB or smaller."
          : (error.message || "Invalid post media.")
      });
    });
  }

  async function ensurePostsBucket() {
    const found = await supabase.storage.getBucket("social-posts");
    if (!found.error && found.data) return;
    const message = String(found.error && found.error.message || "").toLowerCase();
    const missing = message.includes("not found") || String(found.error && found.error.statusCode || "") === "404";
    if (!missing) throw found.error || new Error("Could not inspect social-posts bucket");
    const created = await supabase.storage.createBucket("social-posts", {
      public: false,
      fileSizeLimit: POST_LIMIT,
      allowedMimeTypes: Array.from(POST_TYPES)
    });
    if (created.error && !String(created.error.message || "").toLowerCase().includes("already exists")) {
      throw created.error;
    }
  }

  async function shapePosts(rows, viewerId) {
    if (!rows || !rows.length) return [];
    const ids = rows.map(row => Number(row.id));
    const authorIds = Array.from(new Set(rows.map(row => Number(row.user_id))));
    const [authorsResult, likesResult, commentsResult, followsResult, savesResult] = await Promise.all([
      supabase.from("users").select("id,username,avatar_url,bio").in("id", authorIds),
      supabase.from("social_post_likes").select("post_id,user_id").in("post_id", ids),
      supabase.from("social_post_comments").select("post_id").in("post_id", ids),
      supabase.from("social_follows").select("following_id").eq("follower_id", viewerId).in("following_id", authorIds),
      supabase.from("social_post_saves").select("post_id").eq("user_id", viewerId).in("post_id", ids)
    ]);
    for (const result of [authorsResult, likesResult, commentsResult, followsResult, savesResult]) {
      if (result.error) throw result.error;
    }
    const authors = new Map((authorsResult.data || []).map(user => [Number(user.id), user]));
    const likes = likesResult.data || [];
    const comments = commentsResult.data || [];
    const followed = new Set((followsResult.data || []).map(row => Number(row.following_id)));
    const savedPostIds = new Set((savesResult.data || []).map(row => Number(row.post_id)));
    return await Promise.all(rows.map(async row => {
      let mediaUrl = null;
      if (row.media_path) {
        const signed = await supabase.storage.from("social-posts").createSignedUrl(row.media_path, 60 * 60);
        if (!signed.error && signed.data) mediaUrl = signed.data.signedUrl;
      }
      const postLikes = likes.filter(item => Number(item.post_id) === Number(row.id));
      return {
        id: row.id,
        user_id: row.user_id,
        caption: row.caption || "",
        media_type: row.media_type,
        media_url: mediaUrl,
        created_at: row.created_at,
        username: (authors.get(Number(row.user_id)) || {}).username || ("User " + row.user_id),
        avatar_url: (authors.get(Number(row.user_id)) || {}).avatar_url || null,
        bio: (authors.get(Number(row.user_id)) || {}).bio || "",
        like_count: postLikes.length,
        comment_count: comments.filter(item => Number(item.post_id) === Number(row.id)).length,
        liked_by_me: postLikes.some(item => Number(item.user_id) === Number(viewerId)),
        saved_by_me: savedPostIds.has(Number(row.id)),
        following_author: Number(row.user_id) === Number(viewerId) || followed.has(Number(row.user_id)),
        is_mine: Number(row.user_id) === Number(viewerId)
      };
    }));
  }

  async function listPosts(req, res, mode) {
    const viewerId = Number(req.user.id);
    try {
      let userIds = null;
      if (mode === "feed") {
        const { data: follows, error: followError } = await supabase
          .from("social_follows").select("following_id").eq("follower_id", viewerId);
        if (followError) throw followError;
        userIds = Array.from(new Set([viewerId, ...(follows || []).map(row => Number(row.following_id))]));
      }
      let query = supabase.from("social_posts").select("id,user_id,caption,media_path,media_type,created_at");
      if (userIds) query = query.in("user_id", userIds);
      const beforeId = String(req.query.beforeId || "").trim();
      if (/^\d+$/.test(beforeId) && beforeId !== "0") query = query.lt("id", beforeId);
      const result = await query.order("id", { ascending: false }).limit(60);
      if (result.error) throw result.error;

      // Do not surface posts from accounts blocked by or blocking the viewer.
      const authorIds = Array.from(new Set((result.data || []).map(row => Number(row.user_id))));
      let excluded = new Set();
      if (authorIds.length) {
        const blockResult = await supabase.from("user_blocks").select("blocker_id,blocked_id")
          .or(`blocker_id.eq.${viewerId},blocked_id.eq.${viewerId}`).limit(1000);
        if (blockResult.error && !["42P01","PGRST205","PGRST204"].includes(String(blockResult.error.code || ""))) throw blockResult.error;
        for (const row of blockResult.data || []) {
          const otherId = Number(row.blocker_id) === viewerId ? Number(row.blocked_id) : Number(row.blocker_id);
          if (authorIds.includes(otherId)) excluded.add(otherId);
        }
      }
      const visible = (result.data || []).filter(row => !excluded.has(Number(row.user_id)));
      res.json(await shapePosts(visible, viewerId));
    } catch (error) {
      console.error("SOCIAL POST LIST:", { code: error && error.code, message: error && error.message });
      const missing = ["42P01","PGRST205","PGRST204"].includes(String(error && error.code || ""));
      res.status(missing ? 503 : 500).json({
        error: missing
          ? "Social features are not set up yet. Run supabase-social-migration.sql in Supabase."
          : "Could not load posts. Check the server logs."
      });
    }
  }

  app.get("/api/social/feed", authMiddleware, (req, res) => listPosts(req, res, "feed"));
  app.get("/api/social/explore", authMiddleware, (req, res) => listPosts(req, res, "explore"));

  app.post("/api/social/posts", authMiddleware, uploadPostMedia, async (req, res) => {
    let uploadedPath = null;
    try {
      const userId = Number(req.user.id);
      const caption = String(req.body.caption || "").trim();
      const media = req.file;
      if (caption.length > 2200) return res.status(400).json({ error: "Caption must be 2,200 characters or fewer." });
      if (!media) return res.status(400).json({ error: "Choose a photo or video for your post." });
      if (!validPostMedia(media)) return res.status(400).json({ error: "The file content does not match its image/video type." });
      await ensurePostsBucket();

      const extension = {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "video/mp4": "mp4", "video/webm": "webm"
      }[media.mimetype];
      uploadedPath = userId + "/" + Date.now() + "-" + crypto.randomBytes(8).toString("hex") + "." + extension;
      const uploaded = await supabase.storage.from("social-posts").upload(uploadedPath, media.buffer, {
        contentType: media.mimetype,
        upsert: false
      });
      if (uploaded.error) throw uploaded.error;

      const saved = await supabase.from("social_posts").insert({
        user_id: userId,
        caption: caption || null,
        media_path: uploadedPath,
        media_type: media.mimetype
      }).select("id,user_id,caption,media_path,media_type,created_at").single();
      if (saved.error) throw saved.error;

      const shaped = await shapePosts([saved.data], userId);
      io.emit("social-post-created", { userId });
      return res.status(201).json({ success: true, post: shaped[0] });
    } catch (error) {
      if (uploadedPath) {
        try { await supabase.storage.from("social-posts").remove([uploadedPath]); } catch (_) {}
      }
      console.error("SOCIAL POST CREATE:", { code: error && error.code, message: error && error.message });
      const message = String(error && error.message || "").toLowerCase();
      const missing = ["42P01","PGRST205","PGRST204"].includes(String(error && error.code || "")) ||
        (message.includes("bucket") && message.includes("not found"));
      return res.status(missing ? 503 : 500).json({
        error: missing
          ? "Social database or media bucket is not ready. Run supabase-social-migration.sql in Supabase."
          : "Could not publish post. Check the server logs and Supabase Storage."
      });
    }
  });

  app.delete("/api/social/posts/:postId", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const lookup = await supabase.from("social_posts").select("id,user_id,media_path").eq("id", postId).maybeSingle();
      if (lookup.error) throw lookup.error;
      if (!lookup.data) return res.status(404).json({ error: "Post not found." });
      if (Number(lookup.data.user_id) !== userId) return res.status(403).json({ error: "You can delete only your own post." });
      const removed = await supabase.from("social_posts").delete().eq("id", postId).eq("user_id", userId);
      if (removed.error) throw removed.error;
      if (lookup.data.media_path) {
        const storage = await supabase.storage.from("social-posts").remove([lookup.data.media_path]);
        if (storage.error) console.warn("SOCIAL POST MEDIA CLEANUP:", storage.error.message);
      }
      io.emit("social-post-deleted", { postId, userId });
      res.json({ success: true });
    } catch (error) {
      console.error("SOCIAL POST DELETE:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not delete post." });
    }
  });

  app.post("/api/social/posts/:postId/like", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (await areBlocked(userId, Number(post.data.user_id))) return res.status(403).json({ error: "You cannot interact with this account." });
      const existing = await supabase.from("social_post_likes").select("id").eq("post_id", postId).eq("user_id", userId).maybeSingle();
      if (existing.error) throw existing.error;
      let liked;
      if (existing.data) {
        const removed = await supabase.from("social_post_likes").delete().eq("post_id", postId).eq("user_id", userId);
        if (removed.error) throw removed.error;
        liked = false;
      } else {
        const inserted = await supabase.from("social_post_likes").insert({ post_id: postId, user_id: userId });
        if (inserted.error) throw inserted.error;
        liked = true;
      }
      res.json({ success: true, liked });
    } catch (error) {
      console.error("SOCIAL LIKE:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not update like. Run the social SQL migration." });
    }
  });

  app.post("/api/social/posts/:postId/report", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), reporterId = Number(req.user.id);
      const reason = String(req.body.reason || "").trim();
      const allowedReasons = ["spam", "harassment", "bullying", "inappropriate", "misinformation", "other"];
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      if (!allowedReasons.includes(reason)) return res.status(400).json({ error: "Choose a valid report reason." });
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (Number(post.data.user_id) === reporterId) return res.status(400).json({ error: "You cannot report your own post." });
      if (await areBlocked(reporterId, Number(post.data.user_id))) return res.status(403).json({ error: "This action is unavailable for this account." });
      const existing = await supabase.from("social_post_reports").select("id")
        .eq("post_id", postId).eq("reporter_id", reporterId).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return res.status(409).json({ error: "You have already reported this post." });
      const created = await supabase.from("social_post_reports").insert({
        post_id: postId, reporter_id: reporterId, reported_user_id: Number(post.data.user_id), reason
      });
      if (created.error) throw created.error;
      res.status(201).json({ success: true, message: "Thanks. Your report has been submitted for review." });
    } catch (error) {
      console.error("SOCIAL POST REPORT:", { code: error && error.code, message: error && error.message });
      const missing = ["42P01","PGRST205","PGRST204"].includes(String(error && error.code || ""));
      res.status(missing ? 503 : 500).json({ error: missing ? "Post reports are not set up. Run the latest Supabase migration." : "Could not submit your report." });
    }
  });

  app.get("/api/social/posts/:postId/comments", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (await areBlocked(Number(req.user.id), Number(post.data.user_id))) return res.status(403).json({ error: "You cannot view this post." });
      const result = await supabase.from("social_post_comments").select("id,post_id,user_id,body,created_at")
        .eq("post_id", postId).order("id", { ascending: true }).limit(100);
      if (result.error) throw result.error;
      const userIds = Array.from(new Set((result.data || []).map(row => Number(row.user_id))));
      let users = [];
      if (userIds.length) {
        const userResult = await supabase.from("users").select("id,username,avatar_url").in("id", userIds);
        if (userResult.error) throw userResult.error;
        users = userResult.data || [];
      }
      const userMap = new Map(users.map(user => [Number(user.id), user]));
      res.json((result.data || []).map(row => ({
        ...row,
        username: (userMap.get(Number(row.user_id)) || {}).username || ("User " + row.user_id),
        avatar_url: (userMap.get(Number(row.user_id)) || {}).avatar_url || null
      })));
    } catch (error) {
      console.error("SOCIAL COMMENTS LIST:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not load comments." });
    }
  });

  app.post("/api/social/posts/:postId/comments", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      const body = String(req.body.body || "").trim();
      if (!Number.isInteger(postId) || postId < 1 || !body || body.length > 1000) {
        return res.status(400).json({ error: "Comment must contain 1–1,000 characters." });
      }
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (await areBlocked(userId, Number(post.data.user_id))) return res.status(403).json({ error: "You cannot comment on this post." });
      const saved = await supabase.from("social_post_comments").insert({ post_id: postId, user_id: userId, body })
        .select("id,post_id,user_id,body,created_at").single();
      if (saved.error) throw saved.error;
      const user = await supabase.from("users").select("username,avatar_url").eq("id", userId).maybeSingle();
      res.status(201).json({
        ...saved.data,
        username: user.data && user.data.username ? user.data.username : "You",
        avatar_url: user.data && user.data.avatar_url ? user.data.avatar_url : null
      });
    } catch (error) {
      console.error("SOCIAL COMMENT CREATE:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not add comment. Run the social SQL migration." });
    }
  });

  app.get("/api/social/saved", authMiddleware, async (req, res) => {
    try {
      const userId = Number(req.user.id);
      const saved = await supabase.from("social_post_saves").select("post_id,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(100);
      if (saved.error) throw saved.error;
      const ids = (saved.data || []).map(row => Number(row.post_id));
      if (!ids.length) return res.json([]);
      const posts = await supabase.from("social_posts")
        .select("id,user_id,caption,media_path,media_type,created_at").in("id", ids);
      if (posts.error) throw posts.error;
      const byId = new Map((posts.data || []).map(row => [Number(row.id), row]));
      const ordered = ids.map(id => byId.get(id)).filter(Boolean);
      res.json(await shapePosts(ordered, userId));
    } catch (error) {
      console.error("SOCIAL SAVED POSTS:", { code: error && error.code, message: error && error.message });
      const missing = ["42P01","PGRST205","PGRST204"].includes(String(error && error.code || ""));
      res.status(missing ? 503 : 500).json({ error: missing ? "Saved posts are not set up. Run the latest supabase-social-migration.sql." : "Could not load saved posts." });
    }
  });

  app.post("/api/social/posts/:postId/save", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (await areBlocked(userId, Number(post.data.user_id))) return res.status(403).json({ error: "You cannot save this post." });
      const existing = await supabase.from("social_post_saves").select("id").eq("post_id", postId).eq("user_id", userId).maybeSingle();
      if (existing.error) throw existing.error;
      let saved;
      if (existing.data) {
        const removed = await supabase.from("social_post_saves").delete().eq("post_id", postId).eq("user_id", userId);
        if (removed.error) throw removed.error;
        saved = false;
      } else {
        const inserted = await supabase.from("social_post_saves").insert({ post_id: postId, user_id: userId });
        if (inserted.error) throw inserted.error;
        saved = true;
      }
      res.json({ success: true, saved });
    } catch (error) {
      console.error("SOCIAL SAVE POST:", { code: error && error.code, message: error && error.message });
      const missing = ["42P01","PGRST205","PGRST204"].includes(String(error && error.code || ""));
      res.status(missing ? 503 : 500).json({ error: missing ? "Saved posts are not set up. Run the latest supabase-social-migration.sql." : "Could not save this post." });
    }
  });

  app.get("/api/social/profile/:userId", authMiddleware, async (req, res) => {
    try {
      const userId = Number(req.params.userId), viewerId = Number(req.user.id);
      if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: "Invalid profile." });
      if (await areBlocked(viewerId, userId)) return res.status(404).json({ error: "This profile is not available." });
      const userResult = await supabase.from("users").select("id,username,avatar_url,bio,created_at").eq("id", userId).maybeSingle();
      if (userResult.error) throw userResult.error;
      if (!userResult.data) return res.status(404).json({ error: "Profile not found." });
      const [followers, following, isFollowing, posts] = await Promise.all([
        supabase.from("social_follows").select("id", { count: "exact", head: true }).eq("following_id", userId),
        supabase.from("social_follows").select("id", { count: "exact", head: true }).eq("follower_id", userId),
        supabase.from("social_follows").select("id").eq("follower_id", viewerId).eq("following_id", userId).maybeSingle(),
        supabase.from("social_posts").select("id,user_id,caption,media_path,media_type,created_at").eq("user_id", userId).order("id", { ascending: false }).limit(60)
      ]);
      for (const result of [followers, following, isFollowing, posts]) if (result.error) throw result.error;
      res.json({
        user: userResult.data,
        follower_count: followers.count || 0,
        following_count: following.count || 0,
        is_following: Boolean(isFollowing.data),
        is_me: viewerId === userId,
        posts: await shapePosts(posts.data || [], viewerId)
      });
    } catch (error) {
      console.error("SOCIAL PROFILE:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not load profile. Check the social SQL migration." });
    }
  });

  app.patch("/api/social/profile", authMiddleware, async (req, res) => {
    try {
      const bio = String(req.body.bio || "").trim();
      if (bio.length > 160) return res.status(400).json({ error: "Bio must be 160 characters or fewer." });
      const result = await supabase.from("users").update({ bio }).eq("id", Number(req.user.id))
        .select("id,username,avatar_url,bio").single();
      if (result.error) throw result.error;
      res.json({ success: true, user: result.data });
    } catch (error) {
      console.error("SOCIAL BIO UPDATE:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not update bio. Run supabase-social-migration.sql." });
    }
  });

  app.post("/api/social/follow/:userId", authMiddleware, async (req, res) => {
    try {
      const followerId = Number(req.user.id), followingId = Number(req.params.userId);
      if (!Number.isInteger(followingId) || followingId < 1 || followingId === followerId) return res.status(400).json({ error: "Choose another valid account." });
      const target = await supabase.from("users").select("id").eq("id", followingId).maybeSingle();
      if (target.error) throw target.error;
      if (!target.data) return res.status(404).json({ error: "Account not found." });
      if (await areBlocked(followerId, followingId)) return res.status(403).json({ error: "You cannot follow this account." });
      const saved = await supabase.from("social_follows").upsert({ follower_id: followerId, following_id: followingId }, { onConflict: "follower_id,following_id", ignoreDuplicates: true });
      if (saved.error) throw saved.error;
      io.emit("social-follow-updated", { followerId, followingId });
      res.json({ success: true, following: true });
    } catch (error) {
      console.error("SOCIAL FOLLOW:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not follow account. Run the social SQL migration." });
    }
  });

  app.delete("/api/social/follow/:userId", authMiddleware, async (req, res) => {
    try {
      const followerId = Number(req.user.id), followingId = Number(req.params.userId);
      if (!Number.isInteger(followingId) || followingId < 1 || followingId === followerId) return res.status(400).json({ error: "Invalid account." });
      const removed = await supabase.from("social_follows").delete().eq("follower_id", followerId).eq("following_id", followingId);
      if (removed.error) throw removed.error;
      io.emit("social-follow-updated", { followerId, followingId });
      res.json({ success: true, following: false });
    } catch (error) {
      console.error("SOCIAL UNFOLLOW:", { code: error && error.code, message: error && error.message });
      res.status(500).json({ error: "Could not unfollow account." });
    }
  });
}

module.exports = { registerSocialRoutes };
