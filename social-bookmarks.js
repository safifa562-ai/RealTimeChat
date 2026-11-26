function registerBookmarkRoutes({ app, supabase, authMiddleware }) {
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
      const blocked = await supabase.from("user_blocks").select("blocker_id,blocked_id")
        .or("blocker_id.eq." + userId + ",blocked_id.eq." + userId).limit(1000);
      if (blocked.error && !["42P01","PGRST205","PGRST204"].includes(String(blocked.error.code || ""))) throw blocked.error;
      const excluded = new Set((blocked.data || []).map(row => Number(row.blocker_id) === userId ? Number(row.blocked_id) : Number(row.blocker_id)));
      const byId = new Map((posts.data || []).filter(row => !excluded.has(Number(row.user_id))).map(row => [Number(row.id), row]));
      const ordered = ids.map(id => byId.get(id)).filter(Boolean);
      const shaped = await Promise.all(ordered.map(async row => {
        let mediaUrl = null;
        if (row.media_path) {
          const signed = await supabase.storage.from("social-posts").createSignedUrl(row.media_path, 3600);
          if (!signed.error && signed.data) mediaUrl = signed.data.signedUrl;
        }
        const [author, likes, comments, follow] = await Promise.all([
          supabase.from("users").select("id,username,avatar_url,bio").eq("id", row.user_id).maybeSingle(),
          supabase.from("social_post_likes").select("user_id").eq("post_id", row.id),
          supabase.from("social_post_comments").select("id", { count: "exact", head: true }).eq("post_id", row.id),
          supabase.from("social_follows").select("id").eq("follower_id", userId).eq("following_id", row.user_id).maybeSingle()
        ]);
        for (const result of [author, likes, comments, follow]) if (result.error) throw result.error;
        return {
          id: row.id, user_id: row.user_id, caption: row.caption || "", media_type: row.media_type,
          media_url: mediaUrl, created_at: row.created_at,
          username: author.data && author.data.username || ("User " + row.user_id),
          avatar_url: author.data && author.data.avatar_url || null,
          bio: author.data && author.data.bio || "",
          like_count: (likes.data || []).length, comment_count: comments.count || 0,
          liked_by_me: (likes.data || []).some(item => Number(item.user_id) === userId),
          following_author: Number(row.user_id) === userId || Boolean(follow.data),
          is_mine: Number(row.user_id) === userId, saved_by_me: true
        };
      }));
      res.json(shaped);
    } catch (error) {
      console.error("SOCIAL SAVED POSTS:", error);
      res.status(500).json({ error: "Could not load saved posts. Run the latest social SQL migration." });
    }
  });

  app.post("/api/social/posts/:postId/save", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const post = await supabase.from("social_posts").select("id,user_id").eq("id", postId).maybeSingle();
      if (post.error) throw post.error;
      if (!post.data) return res.status(404).json({ error: "Post not found." });
      if (Number(post.data.user_id) === userId) {
        // Saving your own post is allowed, just like saving any other visible post.
      }
      const saved = await supabase.from("social_post_saves")
        .upsert({ post_id: postId, user_id: userId }, { onConflict: "post_id,user_id", ignoreDuplicates: true });
      if (saved.error) throw saved.error;
      res.json({ success: true, saved: true });
    } catch (error) {
      console.error("SOCIAL SAVE POST:", error);
      res.status(500).json({ error: "Could not save post. Run the latest social SQL migration." });
    }
  });

  app.delete("/api/social/posts/:postId/save", authMiddleware, async (req, res) => {
    try {
      const postId = Number(req.params.postId), userId = Number(req.user.id);
      if (!Number.isInteger(postId) || postId < 1) return res.status(400).json({ error: "Invalid post." });
      const removed = await supabase.from("social_post_saves").delete().eq("post_id", postId).eq("user_id", userId);
      if (removed.error) throw removed.error;
      res.json({ success: true, saved: false });
    } catch (error) {
      console.error("SOCIAL UNSAVE POST:", error);
      res.status(500).json({ error: "Could not remove saved post." });
    }
  });
}

module.exports = { registerBookmarkRoutes };
