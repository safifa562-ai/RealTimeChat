const socket = io();

let username = "";

function joinChat() {
  const name = document.getElementById("nameInput").value.trim();

  if (!name) {
    alert("Please enter your name");
    return;
  }

  username = name;

  document.getElementById("login").style.display = "none";
  document.getElementById("chat").style.display = "flex";
}

function sendMessage() {
  const input = document.getElementById("messageInput");
  const message = input.value.trim();

  if (!message) return;

  socket.emit("chat message", {
    name: username,
    message: message
  });

  input.value = "";
}

socket.on("chat message", (data) => {
  const messages = document.getElementById("messages");

  const div = document.createElement("div");
  div.className = "message";

  div.innerHTML = `
    <b>${data.name}</b><br>
    ${data.message}<br>
    <small>${data.time}</small>
  `;

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
});
