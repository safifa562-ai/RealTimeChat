const socket = io();

let currentUser = null;


// ======================
// SHOW LOGIN
// ======================

function showLogin() {

  document.getElementById("loginForm").style.display = "block";
  document.getElementById("signupForm").style.display = "none";

  document.getElementById("authTitle").textContent =
    "Login to continue";

  document.getElementById("authMessage").textContent = "";
}


// ======================
// SHOW SIGNUP
// ======================

function showSignup() {

  document.getElementById("loginForm").style.display = "none";
  document.getElementById("signupForm").style.display = "block";

  document.getElementById("authTitle").textContent =
    "Create your account";

  document.getElementById("authMessage").textContent = "";
}


// ======================
// SIGNUP
// ======================

async function signup() {

  const username =
    document.getElementById("signupUsername").value.trim();

  const password =
    document.getElementById("signupPassword").value;

  if (!username || !password) {

    showMessage("Enter username and password");

    return;
  }

  try {

    const response = await fetch("/api/signup", {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        username,
        password
      })

    });

    const data = await response.json();

    if (!response.ok) {

      showMessage(data.message);

      return;
    }

    localStorage.setItem("token", data.token);

    currentUser = data.user;

    openChat();

  } catch (error) {

    showMessage("Server connection error");

  }
}


// ======================
// LOGIN
// ======================

async function login() {

  const username =
    document.getElementById("loginUsername").value.trim();

  const password =
    document.getElementById("loginPassword").value;

  if (!username || !password) {

    showMessage("Enter username and password");

    return;
  }

  try {

    const response = await fetch("/api/login", {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        username,
        password
      })

    });

    const data = await response.json();

    if (!response.ok) {

      showMessage(data.message);

      return;
    }

    localStorage.setItem("token", data.token);

    currentUser = data.user;

    openChat();

  } catch (error) {

    showMessage("Server connection error");

  }
}


// ======================
// OPEN CHAT
// ======================

function openChat() {

  document.querySelector(".auth-container").style.display =
    "none";

  document.getElementById("chatApp").style.display =
    "flex";

}


// ======================
// LOGOUT
// ======================

function logout() {

  localStorage.removeItem("token");

  currentUser = null;

  location.reload();

}


// ======================
// MESSAGE
// ======================

function sendMessage() {

  const input =
    document.getElementById("messageInput");

  const message = input.value.trim();

  if (!message || !currentUser) return;

  socket.emit("chat message", {

    name: currentUser.username,

    message: message

  });

  input.value = "";
}


// ======================
// RECEIVE MESSAGE
// ======================

socket.on("chat message", function(data) {

  const messages =
    document.getElementById("messages");

  const div =
    document.createElement("div");

  div.className = "message";

  div.textContent =
    data.name +
    ": " +
    data.message +
    " • " +
    data.time;

  messages.appendChild(div);

  messages.scrollTop =
    messages.scrollHeight;

});


// ======================
// ENTER TO SEND
// ======================

function handleEnter(event) {

  if (event.key === "Enter") {

    sendMessage();

  }
}


// ======================
// MESSAGE DISPLAY
// ======================

function showMessage(message) {

  document.getElementById("authMessage")
    .textContent = message;

}
