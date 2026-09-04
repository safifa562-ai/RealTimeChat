let token = localStorage.getItem("token");

if (!token) {
  window.location.href = "/";
}


// =========================
// API HELPER
// =========================

async function api(url, options = {}) {

  options.headers = {
    ...(options.headers || {}),
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json"
  };

  const response = await fetch(url, options);

  const data = await response.json();

  if (response.status === 401) {
    logout();
    return;
  }

  return data;
}


// =========================
// SEARCH USERS
// =========================

async function searchUsers() {

  const search =
    document.getElementById("searchInput").value.trim();

  const results =
    document.getElementById("searchResults");

  if (!search) {
    results.innerHTML = "";
    return;
  }

  const users = await api(
    "/api/users?search=" + encodeURIComponent(search)
  );

  results.innerHTML = "";

  users.forEach(user => {

    const div = document.createElement("div");

    div.className = "user-card";

    div.innerHTML = `
      <span>👤 ${user.username}</span>
      <button onclick="sendRequest(${user.id})">
        Add Friend
      </button>
    `;

    results.appendChild(div);
  });
}


// =========================
// SEND REQUEST
// =========================

async function sendRequest(userId) {

  const data = await api("/api/friend-request", {

    method: "POST",

    body: JSON.stringify({
      receiverId: userId
    })

  });

  alert(data.message);

}


// =========================
// LOAD REQUESTS
// =========================

async function loadRequests() {

  const requests =
    await api("/api/friend-requests");

  const box =
    document.getElementById("requests");

  box.innerHTML = "";

  requests.forEach(request => {

    const div = document.createElement("div");

    div.className = "user-card";

    div.innerHTML = `
      <span>👤 ${request.username}</span>

      <button onclick="requestAction(${request.id}, 'accept')">
        ✅ Accept
      </button>

      <button onclick="requestAction(${request.id}, 'reject')">
        ❌ Reject
      </button>
    `;

    box.appendChild(div);

  });

}


// =========================
// ACCEPT / REJECT
// =========================

async function requestAction(id, action) {

  const data =
    await api("/api/friend-request/" + id, {

      method: "POST",

      body: JSON.stringify({
        action: action
      })

    });

  alert(data.message);

  loadRequests();
  loadFriends();

}


// =========================
// FRIENDS
// =========================

async function loadFriends() {

  const friends =
    await api("/api/friends");

  const box =
    document.getElementById("friends");

  box.innerHTML = "";

  friends.forEach(friend => {

    const div = document.createElement("div");

    div.className = "user-card";

    div.innerHTML = `
      <span>🟢 ${friend.username}</span>

      <button onclick="openChat(${friend.id}, '${friend.username}')">
        💬 Message
      </button>
    `;

    box.appendChild(div);

  });

}


// =========================
// OPEN CHAT
// =========================

function openChat(id, username) {

  alert(
    "Private chat with " +
    username +
    " next step mein banega."
  );

}


// =========================
// LOGOUT
// =========================

function logout() {

  localStorage.removeItem("token");

  window.location.href = "/";
}


// =========================
// START
// =========================

loadRequests();
loadFriends();
