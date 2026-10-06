/* =========================================================
   RealTimeChat - FULL FRONTEND JAVASCRIPT
   Works with the upgraded Supabase + Socket.IO server
========================================================= */

let socket = null;

let currentUser = null;
let selectedUser = null;

let allUsers = [];
let onlineUserIds = [];

let localStream = null;
let peerConnection = null;

let incomingCallData = null;
let pendingCallType = "audio";

let isMuted = false;
let isCameraOff = false;

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};


/* =========================================================
   AUTH HELPERS
========================================================= */

function getToken() {
  return localStorage.getItem("rtc_token");
}


function authHeaders(extra = {}) {
  const token = getToken();

  return {
    ...extra,
    ...(token
      ? {
          Authorization: "Bearer " + token
        }
      : {})
  };
}


function showAuthMessage(message, success = false) {
  const box = document.getElementById("authMessage");

  if (!box) return;

  box.textContent = message;

  box.style.color = success
    ? "#22c55e"
    : "#ef4444";
}


function clearAuth() {
  document.getElementById(
    "loginUsername"
  ).value = "";

  document.getElementById(
    "loginPassword"
  ).value = "";

  document.getElementById(
    "registerUsername"
  ).value = "";

  document.getElementById(
    "registerPassword"
  ).value = "";

  showAuthMessage("");
}


/* =========================================================
   REGISTER
========================================================= */

async function register() {
  const username =
    document.getElementById(
      "registerUsername"
    ).value.trim();

  const password =
    document.getElementById(
      "registerPassword"
    ).value;

  if (!username || !password) {
    showAuthMessage(
      "Enter username and password"
    );
    return;
  }

  if (username.length < 3) {
    showAuthMessage(
      "Username must be at least 3 characters"
    );
    return;
  }

  if (password.length < 6) {
    showAuthMessage(
      "Password must be at least 6 characters"
    );
    return;
  }

  try {
    showAuthMessage(
      "Creating account..."
    );

    const response =
      await fetch("/api/register", {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          username,
          password
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      showAuthMessage(
        data.error ||
        "Registration failed"
      );
      return;
    }

    /*
      Save token + user
    */

    localStorage.setItem(
      "rtc_token",
      data.token
    );

    localStorage.setItem(
      "rtc_user",
      JSON.stringify(data.user)
    );

    currentUser = data.user;

    showAuthMessage(
      "Account created successfully!",
      true
    );

    /*
      Open app automatically
    */

    setTimeout(() => {
      openApp();
    }, 500);

  } catch (error) {
    console.error(
      "REGISTER ERROR:",
      error
    );

    showAuthMessage(
      "Server connection failed"
    );
  }
}


/* =========================================================
   LOGIN
========================================================= */

async function login() {
  const username =
    document.getElementById(
      "loginUsername"
    ).value.trim();

  const password =
    document.getElementById(
      "loginPassword"
    ).value;

  if (!username || !password) {
    showAuthMessage(
      "Enter username and password"
    );
    return;
  }

  try {
    showAuthMessage(
      "Logging in..."
    );

    const response =
      await fetch("/api/login", {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          username,
          password
        })
      });

    const data =
      await response.json();

    if (!response.ok) {
      showAuthMessage(
        data.error ||
        "Login failed"
      );
      return;
    }

    /*
      IMPORTANT:
      New backend returns JWT token
    */

    localStorage.setItem(
      "rtc_token",
      data.token
    );

    localStorage.setItem(
      "rtc_user",
      JSON.stringify(data.user)
    );

    currentUser = data.user;

    openApp();

  } catch (error) {
    console.error(
      "LOGIN ERROR:",
      error
    );

    showAuthMessage(
      "Server connection failed"
    );
  }
}


/* =========================================================
   OPEN APP
========================================================= */

function openApp() {
  if (!currentUser) return;

  document
    .getElementById("authScreen")
    .classList.add("hidden");

  document
    .getElementById("appScreen")
    .classList.remove("hidden");

  document
    .getElementById("profileName")
    .textContent =
    currentUser.username;

  document
    .getElementById("profileId")
    .textContent =
    "ID: " + currentUser.id;

  connectSocket();

  loadUsers();
}


/* =========================================================
   SOCKET CONNECTION
========================================================= */

function connectSocket() {
  if (socket) return;

  socket = io({
    transports: [
      "websocket",
      "polling"
    ]
  });


  /* ---------------- CONNECT ---------------- */

  socket.on(
    "connect",
    () => {
      console.log(
        "Socket connected:",
        socket.id
      );

      socket.emit(
        "user-online",
        currentUser
      );
    }
  );


  /* ---------------- ONLINE USERS ---------------- */

  socket.on(
    "online-users",
    ids => {
      onlineUserIds =
        ids.map(String);

      renderUsers();
    }
  );


  /* ---------------- PRIVATE MESSAGE ---------------- */

  socket.on(
    "private-message",
    message => {
      handleIncomingMessage(
        message
      );
    }
  );


  /* ---------------- MESSAGE ERROR ---------------- */

  socket.on(
    "message-error",
    data => {
      alert(
        data.error ||
        "Message failed"
      );
    }
  );


  /* ---------------- MESSAGE DELETED ---------------- */

  socket.on(
    "message-deleted",
    data => {
      loadChatHistory();
    }
  );


  /* ---------------- TYPING ---------------- */

  socket.on(
    "typing",
    data => {
      if (
        selectedUser &&
        Number(data.senderId) ===
          Number(selectedUser.id)
      ) {
        showTyping(
          data.typing
        );
      }
    }
  );


  /* ---------------- READ RECEIPT ---------------- */

  socket.on(
    "messages-read",
    data => {
      updateReadStatus();
    }
  );


  /* ---------------- INCOMING CALL ---------------- */

  socket.on(
    "incoming-call",
    data => {
      incomingCallData = data;

      pendingCallType =
        data.callType ||
        "audio";

      const callerName =
        data.callerName ||
        "Someone";

      const callerText =
        document.getElementById(
          "callerText"
        );

      if (callerText) {
        callerText.textContent =
          callerName +
          " is calling you (" +
          pendingCallType +
          ")";
      }

      document
        .getElementById(
          "incomingCall"
        )
        .classList.remove(
          "hidden"
        );
    }
  );


  /* ---------------- CALL OFFER ---------------- */

  socket.on(
    "call-offer",
    async data => {
      incomingCallData = {
        ...incomingCallData,
        ...data
      };

      pendingCallType =
        data.callType ||
        pendingCallType ||
        "audio";
    }
  );


  /* ---------------- CALL ANSWER ---------------- */

  socket.on(
    "call-answer",
    async data => {
      try {
        if (!peerConnection) {
          return;
        }

        await peerConnection
          .setRemoteDescription(
            new RTCSessionDescription(
              data.answer
            )
          );

      } catch (error) {
        console.error(
          "CALL ANSWER ERROR:",
          error
        );
      }
    }
  );


  /* ---------------- ICE ---------------- */

  socket.on(
    "ice-candidate",
    async data => {
      try {
        if (
          peerConnection &&
          data.candidate
        ) {
          await peerConnection
            .addIceCandidate(
              new RTCIceCandidate(
                data.candidate
              )
            );
        }
      } catch (error) {
        console.error(
          "ICE ERROR:",
          error
        );
      }
    }
  );


  /* ---------------- END CALL ---------------- */

  socket.on(
    "end-call",
    () => {
      closeCall();
    }
  );


  /* ---------------- CALL ERROR ---------------- */

  socket.on(
    "call-error",
    data => {
      alert(
        data.error ||
        "Call failed"
      );
    }
  );


  /* ---------------- DISCONNECT ---------------- */

  socket.on(
    "disconnect",
    () => {
      console.log(
        "Socket disconnected"
      );
    }
  );
}


/* =========================================================
   LOAD USERS
========================================================= */

async function loadUsers() {
  try {
    const response =
      await fetch(
        "/api/users",
        {
          headers:
            authHeaders()
        }
      );

    if (
      response.status === 401
    ) {
      logout();
      return;
    }

    const users =
      await response.json();

    if (!Array.isArray(users)) {
      return;
    }

    allUsers = users;

    renderUsers();

  } catch (error) {
    console.error(
      "LOAD USERS ERROR:",
      error
    );
  }
}


/* =========================================================
   RENDER USERS
========================================================= */

function renderUsers() {
  const list =
    document.getElementById(
      "usersList"
    );

  if (!list) return;

  list.innerHTML = "";

  allUsers.forEach(user => {

    if (
      currentUser &&
      Number(user.id) ===
        Number(currentUser.id)
    ) {
      return;
    }

    const div =
      document.createElement(
        "div"
      );

    div.className =
      "userItem";

    const online =
      onlineUserIds.includes(
        String(user.id)
      );

    const dotClass =
      online
        ? "onlineDot"
        : "offlineDot";

    div.innerHTML = `
      <span class="${dotClass}"></span>
      <strong>${escapeHtml(
        user.username
      )}</strong>

      <small style="
        display:block;
        color:#777;
        margin-top:4px;
      ">
        ID: ${user.id}
        ${online ? " • Online" : " • Offline"}
      </small>
    `;

    div.onclick = () => {
      selectUser(user);
    };

    list.appendChild(div);
  });
}


/* =========================================================
   SELECT USER
========================================================= */

async function selectUser(user) {
  selectedUser = user;

  document.getElementById(
    "chatUserName"
  ).textContent =
    user.username;

  const online =
    onlineUserIds.includes(
      String(user.id)
    );

  document.getElementById(
    "chatUserStatus"
  ).textContent =
    online
      ? "Online"
      : "Offline";

  await loadChatHistory();
}


/* =========================================================
   CONNECT USER BY ID
========================================================= */

async function connectUser() {
  const input =
    document.getElementById(
      "connectUserId"
    );

  const id =
    Number(input.value);

  if (!id) {
    alert(
      "Enter a valid User ID"
    );
    return;
  }

  const user =
    allUsers.find(
      u =>
        Number(u.id) === id
    );

  if (user) {
    await selectUser(user);
    input.value = "";
    return;
  }

  try {
    const response =
      await fetch(
        "/api/users",
        {
          headers:
            authHeaders()
        }
      );

    const users =
      await response.json();

    const found =
      users.find(
        u =>
          Number(u.id) === id
      );

    if (!found) {
      alert(
        "User not found"
      );
      return;
    }

    allUsers = users;

    await selectUser(found);

    input.value = "";

    renderUsers();

  } catch (error) {
    console.error(error);

    alert(
      "Could not find user"
    );
  }
}


/* =========================================================
   CHAT HISTORY
========================================================= */

async function loadChatHistory() {
  if (
    !currentUser ||
    !selectedUser
  ) {
    return;
  }

  const container =
    document.getElementById(
      "messages"
    );

  container.innerHTML = `
    <div class="emptyChat">
      Loading messages...
    </div>
  `;

  try {
    const response =
      await fetch(
        `/api/messages/${currentUser.id}/${selectedUser.id}`,
        {
          headers:
            authHeaders()
        }
      );

    if (
      response.status === 401
    ) {
      logout();
      return;
    }

    const messages =
      await response.json();

    container.innerHTML = "";

    if (
      !Array.isArray(messages) ||
      messages.length === 0
    ) {
      container.innerHTML = `
        <div class="emptyChat">
          No messages yet.<br>
          Start the conversation!
        </div>
      `;
      return;
    }

    messages.forEach(
      message => {
        displayMessage(
          message,
          false
        );
      }
    );

    scrollMessages();

    /*
      Mark received messages read
    */

    if (socket) {
      socket.emit(
        "messages-read",
        {
          senderId:
            selectedUser.id
        }
      );
    }

  } catch (error) {
    console.error(
      "HISTORY ERROR:",
      error
    );

    container.innerHTML = `
      <div class="emptyChat">
        Could not load messages.
      </div>
    `;
  }
}


/* =========================================================
   SEND MESSAGE
========================================================= */

function sendMessage() {
  const input =
    document.getElementById(
      "messageInput"
    );

  const message =
    input.value.trim();

  if (!message) {
    return;
  }

  if (!selectedUser) {
    alert(
      "Select a user first"
    );
    return;
  }

  if (!socket) {
    alert(
      "Socket is not connected"
    );
    return;
  }

  socket.emit(
    "private-message",
    {
      senderId:
        currentUser.id,

      receiverId:
        selectedUser.id,

      message
    }
  );

  input.value = "";

  stopTyping();
}


/* =========================================================
   ENTER TO SEND
========================================================= */

function handleMessageKey(event) {
  if (
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    event.preventDefault();

    sendMessage();
  }
}


/* =========================================================
   MESSAGE RECEIVED
========================================================= */

function handleIncomingMessage(
  message
) {
  /*
    Only display in current conversation
  */

  if (
    !selectedUser
  ) {
    return;
  }

  const senderId =
    Number(message.sender_id);

  const receiverId =
    Number(message.receiver_id);

  const myId =
    Number(currentUser.id);

  const selectedId =
    Number(selectedUser.id);

  const belongsToChat =
    (
      senderId === myId &&
      receiverId === selectedId
    ) ||
    (
      senderId === selectedId &&
      receiverId === myId
    );

  if (!belongsToChat) {
    /*
      Message belongs to another chat.
      Refresh users for future notification UI.
    */

    return;
  }

  displayMessage(
    message,
    true
  );

  if (
    senderId !== myId &&
    socket
  ) {
    socket.emit(
      "messages-read",
      {
        senderId
      }
    );
  }
}


/* =========================================================
   DISPLAY MESSAGE
========================================================= */

function displayMessage(
  message,
  animate = true
) {
  const container =
    document.getElementById(
      "messages"
    );

  if (!container) {
    return;
  }

  const empty =
    container.querySelector(
      ".emptyChat"
    );

  if (empty) {
    empty.remove();
  }

  const div =
    document.createElement(
      "div"
    );

  const mine =
    Number(message.sender_id) ===
    Number(currentUser.id);

  div.className =
    "message " +
    (
      mine
        ? "mine"
        : "theirs"
    );

  if (message.is_deleted) {
    div.innerHTML = `
      <div style="opacity:.6;">
        Message deleted
      </div>
    `;
  } else {

    let body = "";

    /*
      FILE MESSAGE
    */

    if (
      message.message_type ===
        "file" &&
      message.file_url
    ) {
      body = `
        <a
          href="${escapeAttribute(
            message.file_url
          )}"
          target="_blank"
          rel="noopener"
          style="
            color:white;
            text-decoration:underline;
          "
        >
          📎 ${escapeHtml(
            message.file_name ||
            "File"
          )}
        </a>
      `;
    } else {

      const safeMessage =
        escapeHtml(
          message.message || ""
        );

      /*
        Preserve line breaks
      */

      body = `
        <div style="
          white-space:pre-wrap;
        ">
          ${safeMessage}
        </div>
      `;
    }

    const time =
      message.created_at
        ? new Date(
            message.created_at
          ).toLocaleTimeString(
            [],
            {
              hour: "2-digit",
              minute: "2-digit"
            }
          )
        : "";

    const readMark =
      mine
        ? (
            message.is_read
              ? " ✓✓"
              : " ✓"
          )
        : "";

    div.innerHTML = `
      ${body}

      <div class="messageTime">
        ${time}
        <span class="readMark">
          ${readMark}
        </span>
      </div>
    `;
  }

  container.appendChild(div);

  scrollMessages();
}


/* =========================================================
   SCROLL CHAT
========================================================= */

function scrollMessages() {
  const container =
    document.getElementById(
      "messages"
    );

  if (!container) return;

  setTimeout(() => {
    container.scrollTop =
      container.scrollHeight;
  }, 20);
}


/* =========================================================
   READ STATUS
========================================================= */

function updateReadStatus() {
  document
    .querySelectorAll(
      ".readMark"
    )
    .forEach(mark => {
      mark.textContent =
        " ✓✓";
    });
}


/* =========================================================
   TYPING
========================================================= */

let typingTimer = null;
let currentlyTyping = false;


function startTyping() {
  if (
    !socket ||
    !selectedUser
  ) {
    return;
  }

  if (!currentlyTyping) {
    currentlyTyping = true;

    socket.emit(
      "typing",
      {
        receiverId:
          selectedUser.id,

        typing: true
      }
    );
  }

  clearTimeout(
    typingTimer
  );

  typingTimer =
    setTimeout(
      stopTyping,
      1200
    );
}


function stopTyping() {
  clearTimeout(
    typingTimer
  );

  if (
    !currentlyTyping ||
    !socket ||
    !selectedUser
  ) {
    return;
  }

  currentlyTyping = false;

  socket.emit(
    "typing",
    {
      receiverId:
        selectedUser.id,

      typing: false
    }
  );
}


function showTyping(
  typing
) {
  const status =
    document.getElementById(
      "chatUserStatus"
    );

  if (!status) return;

  if (typing) {
    status.textContent =
      "typing...";
  } else {

    const online =
      onlineUserIds.includes(
        String(
          selectedUser?.id
        )
      );

    status.textContent =
      online
        ? "Online"
        : "Offline";
  }
}


/* =========================================================
   MESSAGE INPUT TYPING EVENT
========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const input =
      document.getElementById(
        "messageInput"
      );

    if (input) {

      input.addEventListener(
        "input",
        () => {
          startTyping();
        }
      );
    }
  }
);


/* =========================================================
   FILE UPLOAD
========================================================= */

async function uploadFile() {
  const input =
    document.getElementById(
      "fileInput"
    );

  const file =
    input.files[0];

  if (!file) {
    return;
  }

  if (!selectedUser) {
    alert(
      "Select a user first"
    );

    input.value = "";
    return;
  }

  /*
    100 MB frontend limit
  */

  if (
    file.size >
    100 * 1024 * 1024
  ) {
    alert(
      "File must be smaller than 100 MB."
    );

    input.value = "";
    return;
  }

  try {
    const formData =
      new FormData();

    formData.append(
      "file",
      file
    );

    const response =
      await fetch(
        "/api/upload",
        {
          method: "POST",

          headers:
            authHeaders(),

          body: formData
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      alert(
        data.error ||
        "Upload failed"
      );

      return;
    }

    /*
      Send uploaded file
      through Socket.IO.
    */

    socket.emit(
      "private-message",
      {
        senderId:
          currentUser.id,

        receiverId:
          selectedUser.id,

        message:
          "📎 " +
          data.file.name,

        messageType:
          "file",

        fileName:
          data.file.name,

        fileUrl:
          data.file.url,

        fileSize:
          data.file.size
      }
    );

  } catch (error) {
    console.error(
      "UPLOAD ERROR:",
      error
    );

    alert(
      "File upload failed"
    );

  } finally {
    input.value = "";
  }
}


/* =========================================================
   AUDIO CALL
========================================================= */

async function startAudioCall() {
  await startCall(
    "audio"
  );
}


/* =========================================================
   VIDEO CALL
========================================================= */

async function startVideoCall() {
  await startCall(
    "video"
  );
}


/* =========================================================
   START CALL
========================================================= */

async function startCall(
  callType
) {
  if (!selectedUser) {
    alert(
      "Select a user first"
    );
    return;
  }

  if (!socket) {
    alert(
      "Socket is not connected"
    );
    return;
  }

  try {

    pendingCallType =
      callType;

    localStream =
      await navigator.mediaDevices
        .getUserMedia({
          audio: true,
          video:
            callType === "video"
        });

    showLocalStream();

    peerConnection =
      createPeerConnection(
        selectedUser.id
      );

    localStream
      .getTracks()
      .forEach(track => {

        peerConnection.addTrack(
          track,
          localStream
        );

      });

    const offer =
      await peerConnection
        .createOffer();

    await peerConnection
      .setLocalDescription(
        offer
      );

    socket.emit(
      "start-call",
      {
        receiverId:
          selectedUser.id,

        callerId:
          currentUser.id,

        callerName:
          currentUser.username,

        callType
      }
    );

    socket.emit(
      "call-offer",
      {
        receiverId:
          selectedUser.id,

        callerId:
          currentUser.id,

        callerName:
          currentUser.username,

        callType,

        offer
      }
    );

  } catch (error) {

    console.error(
      "START CALL ERROR:",
      error
    );

    alert(
      "Microphone/camera permission is required."
    );

    closeCall();
  }
}


/* =========================================================
   CREATE WEBRTC CONNECTION
========================================================= */

function createPeerConnection(
  remoteUserId
) {
  const pc =
    new RTCPeerConnection(
      rtcConfig
    );

  pc.onicecandidate =
    event => {

      if (
        event.candidate &&
        socket
      ) {

        socket.emit(
          "ice-candidate",
          {
            receiverId:
              remoteUserId,

            candidate:
              event.candidate
          }
        );
      }
    };


  pc.ontrack =
    event => {

      const remoteVideo =
        document.getElementById(
          "remoteVideo"
        );

      if (
        remoteVideo &&
        event.streams[0]
      ) {
        remoteVideo.srcObject =
          event.streams[0];
      }
    };


  pc.onconnectionstatechange =
    () => {

      console.log(
        "WebRTC state:",
        pc.connectionState
      );

      if (
        pc.connectionState ===
          "failed" ||
        pc.connectionState ===
          "closed"
      ) {
        closeCall();
      }
    };


  return pc;
}


/* =========================================================
   ACCEPT CALL
========================================================= */

async function acceptCall() {
  document
    .getElementById(
      "incomingCall"
    )
    .classList.add(
      "hidden"
    );

  if (!incomingCallData) {
    return;
  }

  const data =
    incomingCallData;

  const callerId =
    data.callerId;

  selectedUser = {
    id: callerId,

    username:
      data.callerName ||
      "Caller"
  };

  document.getElementById(
    "chatUserName"
  ).textContent =
    selectedUser.username;

  pendingCallType =
    data.callType ||
    "audio";

  try {

    localStream =
      await navigator.mediaDevices
        .getUserMedia({
          audio: true,

          video:
            pendingCallType ===
            "video"
        });

    showLocalStream();

    peerConnection =
      createPeerConnection(
        callerId
      );

    localStream
      .getTracks()
      .forEach(track => {

        peerConnection.addTrack(
          track,
          localStream
        );

      });

    /*
      Offer may have arrived
      before Accept.
    */

    if (data.offer) {

      await peerConnection
        .setRemoteDescription(
          new RTCSessionDescription(
            data.offer
          )
        );

      const answer =
        await peerConnection
          .createAnswer();

      await peerConnection
        .setLocalDescription(
          answer
        );

      socket.emit(
        "call-answer",
        {
          receiverId:
            callerId,

          answer
        }
      );
    }

  } catch (error) {

    console.error(
      "ACCEPT CALL ERROR:",
      error
    );

    alert(
      "Could not access microphone/camera."
    );

    closeCall();
  }

  incomingCallData =
    null;
}


/* =========================================================
   REJECT CALL
========================================================= */

function rejectCall() {
  document
    .getElementById(
      "incomingCall"
    )
    .classList.add(
      "hidden"
    );

  incomingCallData =
    null;
}


/* =========================================================
   SHOW LOCAL STREAM
========================================================= */

function showLocalStream() {
  const video =
    document.getElementById(
      "localVideo"
    );

  if (video) {
    video.srcObject =
      localStream;
  }

  document
    .getElementById(
      "videoPanel"
    )
    .classList.remove(
      "hidden"
    );
}


/* =========================================================
   MUTE
========================================================= */

function toggleMute() {
  if (!localStream) {
    return;
  }

  const tracks =
    localStream.getAudioTracks();

  tracks.forEach(track => {
    track.enabled =
      !track.enabled;
  });

  isMuted =
    !isMuted;
}


/* =========================================================
   CAMERA
========================================================= */

function toggleCamera() {
  if (!localStream) {
    return;
  }

  const tracks =
    localStream.getVideoTracks();

  tracks.forEach(track => {
    track.enabled =
      !track.enabled;
  });

  isCameraOff =
    !isCameraOff;
}


/* =========================================================
   SCREEN SHARE
========================================================= */

async function shareScreen() {
  if (!selectedUser) {
    alert(
      "Select a user first"
    );
    return;
  }

  if (!peerConnection) {
    alert(
      "Start a video call first."
    );
    return;
  }

  try {

    const screenStream =
      await navigator.mediaDevices
        .getDisplayMedia({
          video: true,
          audio: true
        });

    const screenTrack =
      screenStream.getVideoTracks()[0];

    const sender =
      peerConnection
        .getSenders()
        .find(
          s =>
            s.track &&
            s.track.kind ===
              "video"
        );

    if (sender) {

      await sender.replaceTrack(
        screenTrack
      );

    }

    const localVideo =
      document.getElementById(
        "localVideo"
      );

    localVideo.srcObject =
      screenStream;

    screenTrack.onended =
      async () => {

        if (
          localStream &&
          peerConnection
        ) {

          const cameraTrack =
            localStream
              .getVideoTracks()[0];

          if (cameraTrack) {

            const sender =
              peerConnection
                .getSenders()
                .find(
                  s =>
                    s.track &&
                    s.track.kind ===
                      "video"
                );

            if (sender) {

              await sender
                .replaceTrack(
                  cameraTrack
                );
            }
          }

          localVideo.srcObject =
            localStream;
        }
      };

    socket.emit(
      "screen-share",
      {
        receiverId:
          selectedUser.id,

        userId:
          currentUser.id
      }
    );

  } catch (error) {

    console.error(
      "SCREEN SHARE ERROR:",
      error
    );
  }
}


/* =========================================================
   END CALL
========================================================= */

function endCall() {

  if (
    selectedUser &&
    socket
  ) {

    socket.emit(
      "end-call",
      {
        receiverId:
          selectedUser.id
      }
    );
  }

  closeCall();
}


/* =========================================================
   CLOSE CALL
========================================================= */

function closeCall() {

  if (peerConnection) {

    peerConnection.ontrack =
      null;

    peerConnection.onicecandidate =
      null;

    peerConnection.close();

    peerConnection =
      null;
  }

  if (localStream) {

    localStream
      .getTracks()
      .forEach(track => {
        track.stop();
      });

    localStream =
      null;
  }

  const localVideo =
    document.getElementById(
      "localVideo"
    );

  const remoteVideo =
    document.getElementById(
      "remoteVideo"
    );

  if (localVideo) {
    localVideo.srcObject =
      null;
  }

  if (remoteVideo) {
    remoteVideo.srcObject =
      null;
  }

  document
    .getElementById(
      "videoPanel"
    )
    .classList.add(
      "hidden"
    );

  isMuted = false;
  isCameraOff = false;
}


/* =========================================================
   LOGOUT
========================================================= */

function logout() {

  closeCall();

  if (socket) {
    socket.disconnect();
    socket = null;
  }

  localStorage.removeItem(
    "rtc_user"
  );

  localStorage.removeItem(
    "rtc_token"
  );

  currentUser = null;
  selectedUser = null;
  allUsers = [];
  onlineUserIds = [];

  document
    .getElementById(
      "appScreen"
    )
    .classList.add(
      "hidden"
    );

  document
    .getElementById(
      "authScreen"
    )
    .classList.remove(
      "hidden"
    );

  document.getElementById(
    "messages"
  ).innerHTML = `
    <div class="emptyChat">
      Connect with a user to start chatting.
    </div>
  `;

  document.getElementById(
    "chatUserName"
  ).textContent =
    "Select a user";

  document.getElementById(
    "chatUserStatus"
  ).textContent =
    "No conversation selected";
}


/* =========================================================
   AUTO LOGIN
========================================================= */

async function autoLogin() {

  const token =
    localStorage.getItem(
      "rtc_token"
    );

  const savedUser =
    localStorage.getItem(
      "rtc_user"
    );

  if (
    !token ||
    !savedUser
  ) {
    return;
  }

  try {

    currentUser =
      JSON.parse(
        savedUser
      );

    /*
      Verify token with backend
    */

    const response =
      await fetch(
        "/api/me",
        {
          headers:
            authHeaders()
        }
      );

    if (!response.ok) {

      localStorage.removeItem(
        "rtc_token"
      );

      localStorage.removeItem(
        "rtc_user"
      );

      currentUser =
        null;

      return;
    }

    const user =
      await response.json();

    currentUser =
      user;

    localStorage.setItem(
      "rtc_user",
      JSON.stringify(
        user
      )
    );

    openApp();

  } catch (error) {

    console.error(
      "AUTO LOGIN ERROR:",
      error
    );

    localStorage.removeItem(
      "rtc_token"
    );

    localStorage.removeItem(
      "rtc_user"
    );
  }
}


/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHtml(
  text
) {
  const div =
    document.createElement(
      "div"
    );

  div.textContent =
    String(
      text ?? ""
    );

  return div.innerHTML;
}


function escapeAttribute(
  text
) {
  return String(
    text ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    );
}


/* =========================================================
   PWA SERVICE WORKER
========================================================= */

if (
  "serviceWorker" in navigator
) {

  window.addEventListener(
    "load",
    () => {

      navigator.serviceWorker
        .register(
          "/service-worker.js"
        )
        .then(() => {

          console.log(
            "Service Worker registered"
          );

        })
        .catch(error => {

          console.error(
            "Service Worker error:",
            error
          );

        });

    }
  );
}


/* =========================================================
   START APP
========================================================= */

window.addEventListener(
  "load",
  () => {
    autoLogin();
  }
);
