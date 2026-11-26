/* VibeCircle social feed. The existing messaging client remains in app.js. */
let socialSection = "feed";
let socialPosts = [];
let socialProfileUserId = null;

function socialEscape(value) {
  return typeof escapeHtml === "function" ? escapeHtml(value == null ? "" : String(value)) : String(value == null ? "" : value).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]); });
}
function socialAttr(value) {
  return typeof escapeAttribute === "function" ? escapeAttribute(value == null ? "" : String(value)) : socialEscape(value);
}
function socialInitial(name) {
  const value = String(name || "?").trim();
  return socialEscape(value ? Array.from(value)[0].toUpperCase() : "?");
}
function socialAvatar(name, url, sizeClass) {
  const src = String(url || "");
  const safeSrc = /^https:\/\/[^ ]+$/i.test(src) ? src : "";
  return '<span class="vc-avatar ' + (sizeClass || "") + '">' +
    (safeSrc ? '<img src="' + socialAttr(safeSrc) + '" alt="" loading="lazy">' : '<span>' + socialInitial(name) + '</span>') +
    '</span>';
}
function socialCaptionHtml(value) {
  const source = String(value || "");
  const pattern = /#[\p{L}\p{N}_]{1,40}/gu;
  let output = "";
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    output += socialEscape(source.slice(cursor, match.index));
    const tag = match[0].slice(1).toLowerCase();
    output += '<button class="vc-hashtag" type="button" data-hashtag="' + socialAttr(tag) + '">' +
      socialEscape(match[0]) + '</button>';
    cursor = match.index + match[0].length;
  }
  return output + socialEscape(source.slice(cursor));
}

function socialTime(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "now";
  const mins = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + "m";
  if (mins < 1440) return Math.floor(mins / 60) + "h";
  return Math.floor(mins / 1440) + "d";
}
function socialMessage(text, kind) {
  ["socialMessage", "socialMessageDialog"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = kind || "info";
  });
}
function socialAuthHeaders() {
  return typeof authHeaders === "function" ? authHeaders() : {};
}

function openSocialSection(section, refresh) {
  const allowed = ["feed", "explore", "saved", "messages", "profile"];
  socialSection = allowed.includes(section) ? section : "feed";
  const socialView = document.getElementById("socialView");
  const chatArea = document.querySelector(".chatArea");
  const isMessages = socialSection === "messages";
  const app = document.getElementById("appScreen");
  if (app) app.classList.toggle("social-active", !isMessages);
  if (socialView) socialView.classList.toggle("hidden", isMessages);
  if (chatArea) chatArea.classList.toggle("hidden", !isMessages);
  document.querySelectorAll("[data-social-nav]").forEach(button => {
    button.classList.toggle("active", button.dataset.socialNav === socialSection);
  });
  if (socialSection === "messages") {
    const app = document.getElementById("appScreen");
    if (app) app.classList.remove("mobile-chat-open");
    return;
  }
  if (socialSection === "profile" && socialProfileUserId) {
    loadSocialProfile(socialProfileUserId);
  } else {
    loadSocialFeed(socialSection === "explore" ? "explore" : socialSection === "saved" ? "saved" : "feed");
  }
}
window.openSocialSection = openSocialSection;

async function loadSocialFeed(mode) {
  mode = ["explore", "saved"].includes(mode) ? mode : "feed";
  const list = document.getElementById("socialFeedList");
  const profilePanel = document.getElementById("socialProfilePanel");
  const feedPanel = document.getElementById("socialFeedPanel");
  const title = document.getElementById("socialPageTitle");
  if (!list || !currentUser) return;
  if (profilePanel) profilePanel.classList.add("hidden");
  if (feedPanel) feedPanel.classList.remove("hidden");
  if (title) title.textContent = mode === "explore" ? "Explore" : mode === "saved" ? "Saved posts" : "Your feed";
  list.innerHTML = '<div class="vc-loading"><span class="vc-spinner"></span> Loading posts…</div>';
  try {
    const q = mode === "explore" ? String((document.getElementById("socialExploreSearch") || {}).value || "").trim() : "";
    let url = mode === "explore" ? "/api/social/explore" : mode === "saved" ? "/api/social/saved" : "/api/social/feed";
    const response = await fetch(url, { headers: socialAuthHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load posts.");
    socialPosts = Array.isArray(data) ? data : [];
    renderSocialPosts();
    renderSocialSuggestions();
    if (mode === "explore" && q) {
      const needle = q.toLowerCase();
      const filtered = socialPosts.filter(post =>
        String(post.username || "").toLowerCase().includes(needle) ||
        String(post.caption || "").toLowerCase().includes(needle)
      );
      socialPosts = filtered;
      renderSocialPosts();
    }
  } catch (error) {
    console.error("SOCIAL FEED:", error);
    list.innerHTML = '<div class="vc-empty"><div class="vc-empty-icon">◌</div><h3>Social feed is not ready</h3><p>' +
      socialEscape(error.message || "Run the social database migration, then reload.") + '</p></div>';
  }
}

function renderSocialPosts() {
  const list = document.getElementById("socialFeedList");
  if (!list) return;
  if (!socialPosts.length) {
    list.innerHTML = '<div class="vc-empty"><div class="vc-empty-icon">✦</div><h3>No posts yet</h3><p>Follow people or share your first photo/video to start the community feed.</p><button class="vc-primary" onclick="openCreatePost()">Create a post</button></div>';
    return;
  }
  list.innerHTML = socialPosts.map(post => socialPostCard(post)).join("");
  openSharedSocialPost();
}

function socialPostCard(post) {
  const media = post.media_url
    ? (String(post.media_type || "").startsWith("video/")
      ? '<video class="vc-post-media" src="' + socialAttr(post.media_url) + '" controls playsinline preload="metadata"></video>'
      : '<img class="vc-post-media" src="' + socialAttr(post.media_url) + '" alt="Post by ' + socialAttr(post.username) + '" loading="lazy">')
    : "";
  const follow = post.is_mine ? "" : '<button class="vc-follow-link" onclick="toggleSocialFollow(' + Number(post.user_id) + ',' + (post.following_author ? 'false' : 'true') + ')">' + (post.following_author ? "Following" : "Follow") + '</button>';
  const deleteButton = post.is_mine ? '<button class="vc-icon-btn" onclick="deleteSocialPost(' + Number(post.id) + ')" title="Delete your post" aria-label="Delete post">⋯</button>' : "";
  const reportButton = post.is_mine ? "" : '<button class="vc-report-link" type="button" onclick="reportSocialPost(' + Number(post.id) + ')" aria-label="Report post">Report</button>';
  const caption = post.caption ? '<p class="vc-caption"><strong>' + socialEscape(post.username) + '</strong> ' + socialCaptionHtml(post.caption) + '</p>' : "";
  return '<article class="vc-post-card" id="socialPost-' + Number(post.id) + '">' +
    '<header class="vc-post-head">' +
      '<button class="vc-user-link" onclick="openSocialProfile(' + Number(post.user_id) + ')">' +
        socialAvatar(post.username, post.avatar_url, "small") +
        '<span><strong>' + socialEscape(post.username) + '</strong><small>' + socialTime(post.created_at) + '</small></span>' +
      '</button>' + follow + reportButton + deleteButton +
    '</header>' +
    '<div class="vc-post-media-wrap">' + media + '</div>' +
    '<div class="vc-post-actions">' +
      '<button class="vc-action ' + (post.liked_by_me ? "liked" : "") + '" onclick="toggleSocialLike(' + Number(post.id) + ')"><span>' + (post.liked_by_me ? "♥" : "♡") + '</span> ' + Number(post.like_count || 0) + '</button>' +
      '<button class="vc-action" onclick="toggleSocialComments(' + Number(post.id) + ')"><span>◯</span> ' + Number(post.comment_count || 0) + ' comments</button>' +
      '<button class="vc-action vc-save-action ' + (post.saved_by_me ? "saved" : "") + '" onclick="toggleSocialSave(' + Number(post.id) + ')" aria-label="' + (post.saved_by_me ? "Remove saved post" : "Save post") + '"><span>' + (post.saved_by_me ? "▣" : "▢") + '</span> ' + (post.saved_by_me ? "Saved" : "Save") + '</button>' +
      '<button class="vc-action vc-share-action" type="button" onclick="shareSocialPost(' + Number(post.id) + ')" aria-label="Share post"><span>↗</span> Share</button>' +
    '</div>' +
    '<div class="vc-post-caption">' + caption + '</div>' +
    '<section class="vc-comments hidden" id="socialComments-' + Number(post.id) + '">' +
      '<div class="vc-comments-list" id="socialCommentsList-' + Number(post.id) + '"></div>' +
      '<form class="vc-comment-form" onsubmit="event.preventDefault(); addSocialComment(' + Number(post.id) + ',this);">' +
        '<input name="body" maxlength="1000" placeholder="Add a kind comment…" required aria-label="Write a comment">' +
        '<button type="submit">Post</button>' +
      '</form>' +
    '</section>' +
  '</article>';
}

async function reportSocialPost(postId) {
  const choices = ["spam", "harassment", "bullying", "inappropriate", "misinformation", "other"];
  const reason = window.prompt("Why are you reporting this post? Choose: " + choices.join(", "));
  if (reason === null) return;
  const normalized = String(reason).trim().toLowerCase();
  if (!choices.includes(normalized)) {
    alert("Please enter one of: " + choices.join(", "));
    return;
  }
  try {
    const response = await fetch("/api/social/posts/" + Number(postId) + "/report", {
      method: "POST",
      headers: { ...socialAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: normalized })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not submit report.");
    alert(data.message || "Report submitted.");
  } catch (error) {
    alert(error.message || "Report failed.");
  }
}
window.reportSocialPost = reportSocialPost;

async function toggleSocialLike(postId) {
  try {
    const response = await fetch("/api/social/posts/" + Number(postId) + "/like", {
      method: "POST", headers: socialAuthHeaders()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not update like.");
    const post = socialPosts.find(item => Number(item.id) === Number(postId));
    if (post) {
      post.liked_by_me = Boolean(data.liked);
      post.like_count = Math.max(0, Number(post.like_count || 0) + (data.liked ? 1 : -1));
      renderSocialPosts();
    }
  } catch (error) {
    alert(error.message || "Like failed.");
  }
}

async function toggleSocialSave(postId) {
  try {
    const response = await fetch("/api/social/posts/" + Number(postId) + "/save", {
      method: "POST", headers: socialAuthHeaders()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save post.");
    const post = socialPosts.find(item => Number(item.id) === Number(postId));
    if (post) {
      post.saved_by_me = Boolean(data.saved);
      if (socialSection === "saved" && !data.saved) {
        socialPosts = socialPosts.filter(item => Number(item.id) !== Number(postId));
      }
      renderSocialPosts();
    }
  } catch (error) {
    alert(error.message || "Save failed.");
  }
}

window.toggleSocialSave = toggleSocialSave;

async function shareSocialPost(postId) {
  const id = Number(postId);
  if (!Number.isSafeInteger(id) || id < 1) return;
  const shareUrl = window.location.origin + window.location.pathname + "#post-" + id;
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({
        title: "VibeCircle post",
        text: "Check out this post on VibeCircle",
        url: shareUrl
      });
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(shareUrl);
    } else {
      const field = document.createElement("textarea");
      field.value = shareUrl;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      if (!copied) throw new Error("Copy is not available in this browser.");
    }
    socialMessage("Post link copied. You can now share it.", "success");
  } catch (error) {
    if (error && error.name === "AbortError") return;
    alert("Could not share the link. Please copy it manually: " + shareUrl);
  }
}
window.shareSocialPost = shareSocialPost;

function openSharedSocialPost() {
  const match = String(window.location.hash || "").match(/^#post-(\d+)$/);
  if (!match) return;
  const post = document.getElementById("socialPost-" + Number(match[1]));
  if (post) {
    post.scrollIntoView({ behavior: "smooth", block: "center" });
    post.setAttribute("tabindex", "-1");
    post.focus({ preventScroll: true });
  }
}

async function toggleSocialComments(postId) {
  const panel = document.getElementById("socialComments-" + Number(postId));
  const list = document.getElementById("socialCommentsList-" + Number(postId));
  if (!panel || !list) return;
  const open = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !open);
  if (!open) return;
  list.innerHTML = '<div class="vc-comment-muted">Loading comments…</div>';
  try {
    const response = await fetch("/api/social/posts/" + Number(postId) + "/comments", { headers: socialAuthHeaders() });
    const data = await response.json().catch(() => []);
    if (!response.ok) throw new Error(data.error || "Could not load comments.");
    list.innerHTML = data.length ? data.map(item =>
      '<p class="vc-comment">' + socialAvatar(item.username, item.avatar_url, "tiny") +
      '<span><strong>' + socialEscape(item.username) + '</strong> ' + socialEscape(item.body) +
      '<small>' + socialTime(item.created_at) + '</small></span></p>'
    ).join("") : '<div class="vc-comment-muted">No comments yet. Start a friendly conversation.</div>';
  } catch (error) {
    list.innerHTML = '<div class="vc-comment-muted">' + socialEscape(error.message) + '</div>';
  }
}

async function addSocialComment(postId, form) {
  const input = form && form.elements && form.elements.body;
  const body = String(input && input.value || "").trim();
  if (!body) return;
  const button = form.querySelector("button[type=submit]");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/social/posts/" + Number(postId) + "/comments", {
      method: "POST",
      headers: { ...socialAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ body })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not add comment.");
    input.value = "";
    const list = document.getElementById("socialCommentsList-" + Number(postId));
    if (list) {
      const line = document.createElement("p");
      line.className = "vc-comment";
      line.innerHTML = socialAvatar(data.username, data.avatar_url, "tiny") +
        '<span><strong>' + socialEscape(data.username) + '</strong> ' + socialEscape(data.body) +
        '<small>' + socialTime(data.created_at) + '</small></span>';
      list.appendChild(line);
    }
    const post = socialPosts.find(item => Number(item.id) === Number(postId));
    if (post) {
      post.comment_count = Number(post.comment_count || 0) + 1;
      const card = document.getElementById("socialPost-" + Number(postId));
      const action = card && card.querySelector(".vc-action:nth-child(2)");
      if (action) action.innerHTML = '<span>◯</span> ' + post.comment_count + ' comments';
    }
  } catch (error) {
    alert(error.message || "Comment failed.");
  } finally {
    if (button) button.disabled = false;
  }
}

function openCreatePost() {
  const dialog = document.getElementById("createSocialPostDialog");
  const form = document.getElementById("createSocialPostForm");
  if (form) form.reset();
  const name = document.getElementById("socialPostFileName");
  if (name) name.textContent = "Choose one photo or video · up to 50 MB";
  socialMessage("", "");
  if (dialog && typeof dialog.showModal === "function") dialog.showModal();
  else dialog && dialog.setAttribute("open", "open");
}
function closeCreatePost() {
  const dialog = document.getElementById("createSocialPostDialog");
  if (dialog && typeof dialog.close === "function") dialog.close();
  else dialog && dialog.removeAttribute("open");
}
async function publishSocialPost(event) {
  if (event) event.preventDefault();
  const form = document.getElementById("createSocialPostForm");
  const fileInput = document.getElementById("socialPostMedia");
  const captionInput = document.getElementById("socialPostCaption");
  const submit = document.getElementById("publishSocialPostBtn");
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    socialMessage("Choose a photo or video first.", "error");
    return;
  }
  const formData = new FormData();
  formData.append("media", fileInput.files[0]);
  formData.append("caption", String(captionInput && captionInput.value || "").trim());
  if (submit) { submit.disabled = true; submit.textContent = "Sharing…"; }
  socialMessage("Uploading your post…", "info");
  try {
    const response = await fetch("/api/social/posts", {
      method: "POST", headers: socialAuthHeaders(), body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Post could not be published.");
    closeCreatePost();
    socialMessage("Your post is live.", "success");
    openSocialSection("feed");
    await loadSocialFeed("feed");
  } catch (error) {
    socialMessage(error.message || "Post upload failed.", "error");
  } finally {
    if (submit) { submit.disabled = false; submit.textContent = "Share post"; }
  }
}

async function deleteSocialPost(postId) {
  if (!confirm("Delete this post permanently?")) return;
  try {
    const response = await fetch("/api/social/posts/" + Number(postId), {
      method: "DELETE", headers: socialAuthHeaders()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not delete post.");
    socialPosts = socialPosts.filter(item => Number(item.id) !== Number(postId));
    renderSocialPosts();
  } catch (error) {
    alert(error.message || "Delete failed.");
  }
}

async function toggleSocialFollow(userId, follow) {
  try {
    const response = await fetch("/api/social/follow/" + Number(userId), {
      method: follow ? "POST" : "DELETE", headers: socialAuthHeaders()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not update follow.");
    if (socialSection === "profile") await loadSocialProfile(userId);
    else await loadSocialFeed(socialSection === "explore" ? "explore" : "feed");
  } catch (error) {
    alert(error.message || "Follow action failed.");
  }
}

async function openSocialProfile(userId) {
  socialProfileUserId = Number(userId);
  openSocialSection("profile");
}
async function loadSocialProfile(userId) {
  const panel = document.getElementById("socialProfilePanel");
  const feedPanel = document.getElementById("socialFeedPanel");
  const title = document.getElementById("socialPageTitle");
  if (!panel || !currentUser) return;
  if (feedPanel) feedPanel.classList.add("hidden");
  panel.classList.remove("hidden");
  panel.innerHTML = '<div class="vc-loading"><span class="vc-spinner"></span> Loading profile…</div>';
  if (title) title.textContent = "Profile";
  try {
    const response = await fetch("/api/social/profile/" + Number(userId), { headers: socialAuthHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not load profile.");
    const user = data.user || {};
    const own = Boolean(data.is_me);
    panel.innerHTML =
      '<header class="vc-profile-head">' +
        socialAvatar(user.username, user.avatar_url, "profile") +
        '<div class="vc-profile-info"><h2>' + socialEscape(user.username || "Member") + '</h2>' +
        '<div class="vc-profile-stats"><span><strong>' + Number(data.posts && data.posts.length || 0) + '</strong> posts</span><span><strong>' + Number(data.follower_count || 0) + '</strong> followers</span><span><strong>' + Number(data.following_count || 0) + '</strong> following</span></div>' +
        '<p>' + socialEscape(user.bio || "No bio yet.") + '</p>' +
        (own ? '<button class="vc-secondary" onclick="editSocialBio()">Edit profile bio</button>' :
          '<button class="vc-primary" onclick="toggleSocialFollow(' + Number(user.id) + ',' + (!data.is_following) + ')">' + (data.is_following ? "Following" : "Follow") + '</button>') +
        '</div>' +
      '</header>' +
      '<div class="vc-profile-posts-title">Posts</div>' +
      '<div class="vc-profile-grid">' + (data.posts || []).map(post => {
        const src = socialAttr(post.media_url || "");
        return '<button class="vc-profile-tile" onclick="openSocialProfilePost(' + Number(post.id) + ')" aria-label="Open post">' +
          (String(post.media_type || "").startsWith("video/") ? '<video src="' + src + '" muted playsinline preload="metadata"></video>' : '<img src="' + src + '" alt="" loading="lazy">') +
        '</button>';
      }).join("") + '</div>';
    socialPosts = data.posts || [];
  } catch (error) {
    panel.innerHTML = '<div class="vc-empty"><h3>Profile unavailable</h3><p>' + socialEscape(error.message) + '</p></div>';
  }
}
function openSocialProfilePost(postId) {
  openSocialSection("feed");
  const post = socialPosts.find(item => Number(item.id) === Number(postId));
  if (!post) return loadSocialFeed("explore").then(() => document.getElementById("socialPost-" + Number(postId))?.scrollIntoView({behavior:"smooth"}));
  document.getElementById("socialPost-" + Number(postId))?.scrollIntoView({behavior:"smooth"});
}
async function editSocialBio() {
  const user = currentUser || {};
  const bio = prompt("Write a short bio (up to 160 characters):", user.bio || "");
  if (bio === null) return;
  if (bio.length > 160) { alert("Bio must be 160 characters or fewer."); return; }
  try {
    const response = await fetch("/api/social/profile", {
      method: "PATCH", headers: { ...socialAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ bio })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not update bio.");
    currentUser.bio = data.user.bio;
    await loadSocialProfile(currentUser.id);
  } catch (error) { alert(error.message || "Could not update bio."); }
}
function renderSocialStories() {
  const strip = document.getElementById("socialStories");
  if (!strip) return;
  const items = Array.isArray(statusItems) ? statusItems.slice(0, 12) : [];
  const own = items.filter(item => Number(item.user_id) === Number(currentUser && currentUser.id));
  const others = items.filter(item => Number(item.user_id) !== Number(currentUser && currentUser.id));
  strip.innerHTML =
    '<button class="vc-story" onclick="setSidebarTab(&quot;status&quot;);openSocialSection(&quot;messages&quot;)">' +
      '<span class="vc-story-ring vc-story-own">' + socialAvatar(currentUser && currentUser.username, currentUser && currentUser.avatar_url, "story") + '<i>＋</i></span><small>Your story</small></button>' +
    others.map(item =>
      '<button class="vc-story" onclick="openStatusViewer(' + Number(item.id) + ')">' +
      '<span class="vc-story-ring">' + socialAvatar(item.username, item.avatar_url, "story") + '</span><small>' + socialEscape(item.username || "Member") + '</small></button>'
    ).join("");
  if (!own.length && !others.length) strip.innerHTML += '<span class="vc-story-empty">Stories from people you follow will appear here.</span>';
}
function renderSocialSuggestions() {
  const list = document.getElementById("socialSuggestions");
  if (!list || !Array.isArray(allUsers)) return;
  const candidates = allUsers.filter(user =>
    currentUser && Number(user.id) !== Number(currentUser.id) &&
    !(friends || []).some(friend => Number(friend.id) === Number(user.id))
  ).slice(0, 5);
  list.innerHTML = candidates.length ? candidates.map(user =>
    '<div class="vc-suggestion">' + socialAvatar(user.username, user.avatar_url, "small") +
    '<span><strong>' + socialEscape(user.username) + '</strong><small>Suggested for you</small></span>' +
    '<button onclick="toggleSocialFollow(' + Number(user.id) + ',true)">Follow</button></div>'
  ).join("") : '<p class="vc-muted">Find people from the People tab.</p>';
}
function searchSocialExplore(event) {
  if (event && event.key && event.key !== "Enter") return;
  loadSocialFeed("explore");
}
function searchSocialHashtag(tag) {
  const input = document.getElementById("socialExploreSearch");
  if (input) input.value = "#" + String(tag || "").replace(/^#/, "").trim();
  openSocialSection("explore");
}
window.searchSocialHashtag = searchSocialHashtag;
window.renderSocialStories = renderSocialStories;
window.renderSocialSuggestions = renderSocialSuggestions;

document.addEventListener("DOMContentLoaded", function() {
  const media = document.getElementById("socialPostMedia");
  if (media) media.addEventListener("change", function() {
    const node = document.getElementById("socialPostFileName");
    if (node) node.textContent = media.files && media.files[0] ? media.files[0].name : "Choose one photo or video · up to 50 MB";
  });

  const feed = document.getElementById("socialFeedList");
  if (feed) {
    feed.addEventListener("click", function(event) {
      const hashtag = event.target.closest("[data-hashtag]");
      if (hashtag) {
        event.preventDefault();
        searchSocialHashtag(hashtag.dataset.hashtag || "");
      }
    });
    let lastImageTap = { image: null, time: 0 };
    feed.addEventListener("pointerup", function(event) {
      const image = event.target.closest("img.vc-post-media");
      if (!image) return;
      const now = Date.now();
      if (image === lastImageTap.image && now - lastImageTap.time < 320) {
        const card = image.closest(".vc-post-card");
        const match = card && card.id.match(/^socialPost-(\d+)$/);
        if (match) {
          const post = socialPosts.find(item => Number(item.id) === Number(match[1]));
          if (post && !post.liked_by_me) toggleSocialLike(Number(match[1]));
        }
        lastImageTap = { image: null, time: 0 };
      } else {
        lastImageTap = { image: image, time: now };
      }
    });
  }
});
