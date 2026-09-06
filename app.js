// =========================
// PAGE NAVIGATION
// =========================

function showPage(pageId, button) {

  const pages = document.querySelectorAll(".page");

  pages.forEach(page => {
    page.classList.remove("active");
  });

  const page = document.getElementById(pageId);

  if (page) {
    page.classList.add("active");
  }

  const buttons = document.querySelectorAll(".nav-btn");

  buttons.forEach(btn => {
    btn.classList.remove("active");
  });

  if (button) {
    button.classList.add("active");
  }
}


// =========================
// PROFILE
// =========================

function updateProfile() {

  if (
    typeof currentUser !== "undefined" &&
    currentUser
  ) {

    const username =
      document.getElementById("profileUsername");

    if (username) {
      username.textContent =
        currentUser.username;
    }

  }

}


// =========================
// LOAD FRIENDS
// =========================

async function loadFriends() {

  if (typeof api !== "function") return;

  const friends =
    await api("/api/friends");

  const box =
    document.getElementById("friends");

  if (!box) return;

  box.innerHTML = "";

  if (!friends || friends.length === 0) {

    box.innerHTML = `
      <div class="empty-box">
        <h3>No friends yet</h3>
        <p>Search for students and add them.</p>
      </div>
    `;

    return;
  }

  friends.forEach(friend => {

    const div =
      document.createElement("div");

    div.className = "user-card";

    div.innerHTML = `
      <span>👤 ${friend.username}</span>

      <button
        onclick="openPrivateChat(${friend.id}, '${friend.username}')"
      >
        💬 Message
      </button>
    `;

    box.appendChild(div);

  });
}


// =========================
// PRIVATE CHAT PLACEHOLDER
// =========================

function openPrivateChat(id, username) {

  showPage("messagesPage");

  alert(
    "Private chat with " +
    username +
    " next step mein connect hoga."
  );

}


// =========================
// START PROFILE
// =========================

setTimeout(() => {

  updateProfile();

  if (typeof loadFriends === "function") {
    loadFriends();
  }

}, 500);
