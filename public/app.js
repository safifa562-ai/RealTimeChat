/* =====================================================
   GLOBALS
===================================================== */

let socket = null;

let currentUser = null;
let selectedUser = null;
let selectedGroup = null;
let chatMode = "private";

let allUsers = [];
let friends = [];
let requests = [];
let knownGroups = [];
let statusItems = [];
let pinnedMessageIds = new Set();
let blockedUserIds = new Set();
let appNotifications = [];
let toastTimers = new Map();

let localStream = null;
let peerConnection = null;

let incomingCallData = null;
let pendingOffer = null;

let iceQueue = [];

let typingTimer = null;
let currentlyTyping = false;
const messageCache = new Map();
let mediaRecorder = null;
let voiceChunks = [];

const rtcConfig = {

  iceServers: [
    {
      urls:
        "stun:stun.l.google.com:19302"
    }
  ]

};


/* =====================================================
   SUPPORTER CHECKOUT (optional Razorpay website checkout)
===================================================== */
let supporterState = { enabled: false, isPremium: false, loaded: false };
let razorpayScriptPromise = null;

function setPremiumMessage(message, kind = "info") {
  const node = document.getElementById("premiumStatusMessage");
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
}

function applyPremiumStatus(data = {}) {
  supporterState = { ...supporterState, ...data, loaded: true };
  const badge = document.getElementById("premiumStatusBadge");
  if (badge) badge.classList.toggle("hidden", !supporterState.isPremium);
  const button = document.getElementById("buySupporterBtn");
  if (!button) return;
  if (supporterState.isPremium) {
    button.disabled = true;
    button.textContent = "Supporter active ✓";
    setPremiumMessage("Thank you! The Supporter badge is active on this account.", "success");
  } else if (!supporterState.enabled) {
    button.disabled = true;
    button.textContent = "Checkout not configured";
    setPremiumMessage(data.error || "Online checkout is not enabled yet. The app owner must configure a verified merchant account and run the SQL migration.", "error");
  } else {
    button.disabled = false;
    button.textContent = "Pay ₹49 once";
    setPremiumMessage("One-time payment only. No subscription or automatic renewal.");
  }
}

async function loadPremiumStatus() {
  if (!currentUser || !getToken()) return;
  try {
    const response = await fetch("/api/premium/status", { headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      applyPremiumStatus({ enabled: false, isPremium: false, error: data.error || "Premium setup is not ready yet." });
      return;
    }
    applyPremiumStatus(data);
  } catch (error) {
    console.warn("SUPPORTER STATUS:", error);
    applyPremiumStatus({ enabled: false, isPremium: false, error: "Could not check the payment setup. Try again later." });
  }
}

async function openPremiumDialog() {
  const menu = document.getElementById("accountMenu");
  const trigger = document.getElementById("accountMenuToggle");
  if (menu) menu.classList.add("hidden");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  const dialog = document.getElementById("premiumDialog");
  if (!dialog) return;
  setPremiumMessage("Checking payment setup…");
  const button = document.getElementById("buySupporterBtn");
  if (button) { button.disabled = true; button.textContent = "Please wait…"; }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "open");
  await loadPremiumStatus();
}

function closePremiumDialog() {
  const dialog = document.getElementById("premiumDialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve(true);
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error("Secure checkout could not load. Check your connection and try again."));
    document.head.appendChild(script);
  });
  return razorpayScriptPromise;
}

async function startSupporterCheckout() {
  const button = document.getElementById("buySupporterBtn");
  if (!currentUser || !getToken()) {
    setPremiumMessage("Log in before starting checkout.", "error");
    return;
  }
  if (!supporterState.enabled || supporterState.isPremium) return;
  if (button) { button.disabled = true; button.textContent = "Starting checkout…"; }
  setPremiumMessage("Creating a secure payment order…");
  try {
    const response = await fetch("/api/billing/razorpay/order", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({})
    });
    const order = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(order.error || "Could not start checkout.");
    await loadRazorpayCheckout();
    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: order.name || "RealTimeChat",
      description: order.description || "One-time Supporter pass",
      order_id: order.orderId,
      prefill: { name: String(currentUser.username || "").slice(0, 80) },
      theme: { color: "#00a884" },
      modal: { ondismiss: () => { if (button && !supporterState.isPremium) { button.disabled = false; button.textContent = "Pay ₹49 once"; } setPremiumMessage("Checkout closed. You have not been charged by this app unless your payment provider confirms it."); } },
      handler: async function (paymentResponse) {
        setPremiumMessage("Payment received by checkout. Verifying securely…");
        try {
          const verifyResponse = await fetch("/api/billing/razorpay/verify", {
            method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(paymentResponse)
          });
          const verified = await verifyResponse.json().catch(() => ({}));
          if (!verifyResponse.ok || !verified.success) throw new Error(verified.error || "Payment verification failed. Do not pay again; contact support with your payment ID.");
          applyPremiumStatus({ enabled: true, isPremium: true, plan: "supporter" });
          setPremiumMessage("Thank you for supporting RealTimeChat! Your Supporter badge is active.", "success");
          showAppToast({ title: "Supporter badge active", body: "Thank you for supporting RealTimeChat!" });
        } catch (error) {
          setPremiumMessage(error.message || "Payment verification did not finish. Do not retry payment yet; contact support.", "error");
          if (button) { button.disabled = true; button.textContent = "Check payment status"; }
        }
      }
    });
    checkout.on("payment.failed", function () {
      setPremiumMessage("Payment did not complete. You have not received the Supporter badge. Check payment status before trying again.", "error");
      if (button) { button.disabled = false; button.textContent = "Try checkout again"; }
    });
    checkout.open();
  } catch (error) {
    setPremiumMessage(error.message || "Could not open checkout.", "error");
    if (button) { button.disabled = false; button.textContent = "Try checkout again"; }
  }
}

/* =====================================================
   TOKEN
===================================================== */

function getToken(){

  return localStorage.getItem(
    "rtc_token"
  );

}


function authHeaders(){

  const token =
    getToken();

  return token
    ? {
        Authorization:
          "Bearer " + token
      }
    : {};

}


/* =====================================================
   IN-APP + BROWSER NOTIFICATIONS
===================================================== */

function notificationStorageKey() {
  return `rtc_notifications_${currentUser ? currentUser.id : "guest"}`;
}

function loadAppNotifications() {
  if (!currentUser) {
    appNotifications = [];
    renderNotificationUI();
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(notificationStorageKey()) || "[]");
    appNotifications = Array.isArray(saved) ? saved.slice(0, 40) : [];
  } catch (_) {
    appNotifications = [];
  }
  renderNotificationUI();
}

function saveAppNotifications() {
  if (!currentUser) return;
  try {
    localStorage.setItem(notificationStorageKey(), JSON.stringify(appNotifications.slice(0, 40)));
  } catch (error) {
    console.warn("Could not save notifications:", error);
  }
}

function notificationTime(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  if (Number.isNaN(date.getTime())) return "Now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderNotificationUI() {
  const badge = document.getElementById("notificationBadge");
  const list = document.getElementById("notificationList");
  const status = document.getElementById("notificationPermissionStatus");
  const enableButton = document.getElementById("notificationPermissionButton");
  const unreadCount = appNotifications.filter(item => item && item.unread).length;

  if (badge) {
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    badge.classList.toggle("hidden", unreadCount === 0);
  }
  if (status || enableButton) {
    const supported = "Notification" in window;
    const permission = supported ? Notification.permission : "unsupported";
    if (status) {
      status.textContent = permission === "granted"
        ? "Browser notifications are enabled"
        : permission === "denied"
          ? "Blocked in browser settings"
          : permission === "unsupported"
            ? "Browser notifications not supported"
            : "Enable notifications on this device";
    }
    if (enableButton) {
      enableButton.textContent = permission === "granted" ? "Enabled" : permission === "denied" ? "Blocked" : "Enable";
      enableButton.disabled = permission === "granted" || permission === "denied" || permission === "unsupported";
      enableButton.title = permission === "denied" ? "Allow notifications in your browser site settings" : "Ask permission for browser notifications";
    }
  }
  if (!list) return;
  list.replaceChildren();
  if (!appNotifications.length) {
    const empty = document.createElement("div");
    empty.className = "notificationEmpty";
    empty.textContent = "No notifications yet.";
    list.appendChild(empty);
    return;
  }

  appNotifications.forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `notificationItem${item.unread ? " unread" : ""}`;
    const icon = document.createElement("span");
    icon.className = "notificationItemIcon";
    icon.textContent = item.type === "friend-request" ? "👋" : item.type === "friend-accepted" ? "✅" : item.type === "group-message" ? "👥" : item.type === "call" ? "📞" : "💬";
    const copy = document.createElement("span");
    copy.className = "notificationItemCopy";
    const title = document.createElement("strong");
    title.textContent = item.title || "Notification";
    const body = document.createElement("span");
    body.textContent = item.body || "";
    const time = document.createElement("small");
    time.textContent = notificationTime(item.createdAt);
    copy.append(title, body, time);
    const dot = document.createElement("span");
    dot.className = `notificationUnreadDot${item.unread ? "" : " read"}`;
    button.append(icon, copy, dot);
    button.addEventListener("click", () => openAppNotification(item.id));
    list.appendChild(button);
  });
}

function toggleNotificationPanel(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const panel = document.getElementById("notificationPanel");
  const button = document.getElementById("notificationBell");
  if (!panel || !button) return;
  const willOpen = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !willOpen);
  button.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) renderNotificationUI();
}

async function enableBrowserNotifications(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (!("Notification" in window)) {
    showAppToast({ title: "Notifications unavailable", body: "This browser does not support system notifications." });
    return;
  }
  if (Notification.permission === "denied") {
    showAppToast({ title: "Notifications are blocked", body: "Allow notifications in your browser's site settings, then refresh RealTimeChat." });
    renderNotificationUI();
    return;
  }
  try {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    renderNotificationUI();
    showAppToast({ title: permission === "granted" ? "Notifications enabled" : "Notifications not enabled", body: permission === "granted" ? "New messages and friend requests can alert you while this app is open in the background." : "You can enable notifications later from the browser's site settings." });
  } catch (error) {
    console.warn("Notification permission:", error);
    showAppToast({ title: "Could not enable notifications", body: "Check your browser's notification settings and try again." });
  }
}

function showAppToast(item) {
  const container = document.getElementById("notificationToasts");
  if (!container) return;
  const toastId = String(item.id || `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const toast = document.createElement("div");
  toast.className = "appToast";
  toast.dataset.toastId = toastId;
  const main = document.createElement("button");
  main.type = "button";
  main.className = "appToastMain";
  const title = document.createElement("strong");
  title.textContent = item.title || "Notification";
  const body = document.createElement("span");
  body.textContent = item.body || "";
  main.append(title, body);
  main.addEventListener("click", () => {
    toast.remove();
    dismissToastTimer(toastId);
    if (item.id) openAppNotification(item.id);
    else toggleNotificationPanel();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "appToastClose";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", event => {
    event.stopPropagation();
    toast.remove();
    dismissToastTimer(toastId);
  });
  toast.append(main, close);
  container.prepend(toast);
  while (container.children.length > 4) container.lastElementChild.remove();
  const timer = window.setTimeout(() => {
    toast.remove();
    toastTimers.delete(toastId);
  }, 6500);
  toastTimers.set(toastId, timer);
}

function dismissToastTimer(id) {
  const timer = toastTimers.get(String(id));
  if (timer) window.clearTimeout(timer);
  toastTimers.delete(String(id));
}

function maybeShowSystemNotification(item) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const options = {
    body: String(item.body || "You have a new notification").slice(0, 180),
    tag: `realtimechat-${item.type || "notification"}-${item.id}`,
    data: {
      id: item.id,
      targetUserId: item.targetUserId || null,
      targetGroupId: item.targetGroupId || null,
      targetTab: item.targetTab || null
    }
  };
  const statusMediaInput = document.getElementById("statusMediaInput");
if (statusMediaInput) statusMediaInput.addEventListener("change", () => {
  const name = document.getElementById("statusMediaName");
  if (name) name.textContent = statusMediaInput.files && statusMediaInput.files[0] ? `${statusMediaInput.files[0].name} · ${(statusMediaInput.files[0].size / 1024 / 1024).toFixed(1)} MB` : "No media selected · max 20 MB";
});

document.addEventListener("click", event => {
  if (!event.target.closest(".contactOptionsWrap")) {
    document.getElementById("contactOptionsMenu")?.classList.add("hidden");
    document.getElementById("contactOptionsToggle")?.setAttribute("aria-expanded", "false");
  }
});

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then(registration => {
        if (registration && typeof registration.showNotification === "function") return registration.showNotification(item.title || "RealTimeChat", options);
        const nativeNotification = new Notification(item.title || "RealTimeChat", options);
        nativeNotification.onclick = () => { window.focus(); if (item.id) openAppNotification(item.id); nativeNotification.close(); };
      })
      .catch(error => console.warn("System notification failed:", error));
  } else {
    try {
      const nativeNotification = new Notification(item.title || "RealTimeChat", options);
      nativeNotification.onclick = () => { window.focus(); if (item.id) openAppNotification(item.id); nativeNotification.close(); };
    } catch (error) {
      console.warn("System notification failed:", error);
    }
  }
}

function addAppNotification(data) {
  if (!currentUser || !data) return;
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    type: data.type || "message",
    title: String(data.title || "RealTimeChat"),
    body: String(data.body || "You have a new notification").slice(0, 240),
    targetUserId: data.targetUserId ? Number(data.targetUserId) : null,
    targetGroupId: data.targetGroupId ? Number(data.targetGroupId) : null,
    targetTab: data.targetTab || null,
    createdAt: Date.now(),
    unread: true
  };
  appNotifications.unshift(item);
  appNotifications = appNotifications.slice(0, 40);
  saveAppNotifications();
  renderNotificationUI();
  showAppToast(item);
  maybeShowSystemNotification(item);
}

async function openAppNotification(id) {
  const item = appNotifications.find(notification => String(notification.id) === String(id));
  if (!item) return;
  item.unread = false;
  saveAppNotifications();
  renderNotificationUI();
  const panel = document.getElementById("notificationPanel");
  const button = document.getElementById("notificationBell");
  if (panel) panel.classList.add("hidden");
  if (button) button.setAttribute("aria-expanded", "false");

  if (item.targetTab === "requests") {
    setSidebarTab("requests");
    await loadRequests();
    return;
  }
  if (item.targetGroupId) {
    if (!knownGroups.length) await loadGroups();
    const group = knownGroups.find(entry => Number(entry.id) === Number(item.targetGroupId));
    if (group) await selectGroup(group);
    else { setSidebarTab("groups"); await loadGroups(); }
    return;
  }
  if (item.targetUserId) await selectUserById(item.targetUserId);
}

function clearNotifications(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  appNotifications = [];
  saveAppNotifications();
  renderNotificationUI();
}

function markTargetNotificationsRead(targetType, targetId) {
  const id = Number(targetId);
  let changed = false;
  appNotifications.forEach(item => {
    const matches = targetType === "group"
      ? Number(item.targetGroupId) === id
      : Number(item.targetUserId) === id;
    if (matches && item.unread) { item.unread = false; changed = true; }
  });
  if (changed) {
    saveAppNotifications();
    renderNotificationUI();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (chatMode === "private" && selectedUser) markTargetNotificationsRead("user", selectedUser.id);
  if (chatMode === "group" && selectedGroup) markTargetNotificationsRead("group", selectedGroup.id);
});

document.addEventListener("click", event => {
  const panel = document.getElementById("notificationPanel");
  const button = document.getElementById("notificationBell");
  if (panel && button && !event.target.closest(".sidebarTopActions")) {
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", event => {
    const data = event.data || {};
    if (data.type === "RTC_OPEN_APP_NOTIFICATION") openAppNotification(data.notificationId);
  });
}

/* =====================================================
   AUTH MESSAGE
===================================================== */

function showAuthMessage(
  message,
  success=false
){

  const box =
    document.getElementById(
      "authMessage"
    );

  box.textContent =
    message;

  box.style.color =
    success
      ? "#22c55e"
      : "#ef4444";

}


function clearAuth(){

  document.getElementById(
    "loginUsername"
  ).value="";

  document.getElementById(
    "loginPassword"
  ).value="";

  document.getElementById(
    "registerUsername"
  ).value="";

  document.getElementById(
    "registerPassword"
  ).value="";

  showAuthMessage("");

}


/* =====================================================
   REGISTER
===================================================== */

async function register(){

  const username =
    document.getElementById(
      "registerUsername"
    ).value.trim();

  const password =
    document.getElementById(
      "registerPassword"
    ).value;

  if(
    username.length < 3 ||
    password.length < 6
  ){

    showAuthMessage(
      "Username: 3+ characters, Password: 6+ characters"
    );

    return;
  }

  try{

    showAuthMessage(
      "Creating account..."
    );

    const response =
      await fetch(
        "/api/register",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            username,
            password
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      showAuthMessage(
        data.error ||
        "Registration failed"
      );

      return;
    }

    showAuthMessage(
      "Account created. Please login.",
      true
    );

    document.getElementById(
      "loginUsername"
    ).value=username;

    document.getElementById(
      "loginPassword"
    ).value=password;

  }catch(error){

    console.error(error);

    showAuthMessage(
      "Server connection failed"
    );

  }

}


/* =====================================================
   LOGIN
===================================================== */

async function login(){

  const username =
    document.getElementById(
      "loginUsername"
    ).value.trim();

  const password =
    document.getElementById(
      "loginPassword"
    ).value;

  if(!username || !password){

    showAuthMessage(
      "Enter username and password"
    );

    return;
  }

  try{

    showAuthMessage(
      "Logging in..."
    );

    const response =
      await fetch(
        "/api/login",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            username,
            password
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      showAuthMessage(
        data.error ||
        "Login failed"
      );

      return;
    }

    localStorage.setItem(
      "rtc_token",
      data.token
    );

    localStorage.setItem(
      "rtc_user",
      JSON.stringify(
        data.user
      )
    );

    currentUser =
      data.user;

    openApp();

  }catch(error){

    console.error(error);

    showAuthMessage(
      "Server connection failed"
    );

  }

}


/* =====================================================
   OPEN APP
===================================================== */

function openApp(){

  if(!currentUser)
    return;

  loadAppNotifications();
  loadPremiumStatus();
  setSidebarTab("chats");
  loadBlockedUsers();
  loadStatuses();
  document.getElementById("appScreen")?.classList.remove("mobile-chat-open");
  setAvatarInitial("profileAvatar", currentUser.username, currentUser.avatar_url);

  document
    .getElementById(
      "authScreen"
    )
    .classList.add(
      "hidden"
    );

  document
    .getElementById(
      "appScreen"
    )
    .classList.remove(
      "hidden"
    );

  document.getElementById(
    "profileName"
  ).textContent =
    currentUser.username;

  document.getElementById(
    "profileId"
  ).textContent =
    "ID: " +
    currentUser.id;

  connectSocket();

  loadUsers();

  loadFriends();

  loadRequests();

  loadGroups();

}


/* =====================================================
   SOCKET
===================================================== */

function connectSocket(){

  if(socket)
    return;

  socket =
    io({
      auth: { token: getToken() },
      transports:[
        "websocket",
        "polling"
      ]
    });


  socket.on(
    "connect",
    ()=>{
      
      socket.emit(
        "user-online",
        currentUser
      );

    }
  );

  socket.on("connect_error", error => {
    console.warn("SOCKET CONNECT ERROR:", error && error.message);
    if (error && /session|authentication|account no longer exists/i.test(error.message || "")) {
      const hint = document.getElementById("authMessage");
      if (hint && document.getElementById("appScreen")?.classList.contains("hidden")) hint.textContent = "Please log in again to connect.";
    }
  });


  socket.on(
    "online-users",
    ()=>{
      loadUsers();
      loadFriends();
    }
  );

  socket.on("profile-updated", data => {
    if (!data || !data.userId) return;
    const id = Number(data.userId);
    const applyAvatar = user => Number(user && user.id) === id
      ? { ...user, avatar_url: data.avatar_url || null }
      : user;
    allUsers = allUsers.map(applyAvatar);
    friends = friends.map(applyAvatar);
    requests = requests.map(request => ({
      ...request,
      sender: request.sender && Number(request.sender.id) === id
        ? { ...request.sender, avatar_url: data.avatar_url || null }
        : request.sender
    }));
    if (currentUser && Number(currentUser.id) === id) {
      currentUser.avatar_url = data.avatar_url || null;
      setAvatarInitial("profileAvatar", currentUser.username, currentUser.avatar_url);
      try { localStorage.setItem("rtc_user", JSON.stringify(currentUser)); } catch (_) {}
    }
    if (selectedUser && Number(selectedUser.id) === id) {
      selectedUser.avatar_url = data.avatar_url || null;
      setAvatarInitial("chatAvatar", selectedUser.username, selectedUser.avatar_url);
    }
    renderUsers();
    renderFriends();
    renderRequests();
  });

  socket.on("account-deleted", data => {
    const deletedId = Number(data && data.userId);
    if (currentUser && Number(currentUser.id) === deletedId) {
      closeDeleteAccountDialog();
      logout();
      showAuthMessage("This account has been permanently deleted.", true);
      return;
    }
    if (currentUser) {
      loadUsers();
      loadFriends();
    }
  });


  socket.on(
    "private-message",
    message => {
      if (!message || !currentUser) return;

      const senderId = Number(message.sender_id);
      const receiverId = Number(message.receiver_id);
      const mine = senderId === Number(currentUser.id);
      const isIncoming = !mine && receiverId === Number(currentUser.id);
      const sameOpenPrivateChat = chatMode === "private" && selectedUser &&
        (Number(selectedUser.id) === senderId || Number(selectedUser.id) === receiverId);

      if (isIncoming && (!sameOpenPrivateChat || document.hidden)) {
        const sender = friends.find(user => Number(user.id) === senderId) || allUsers.find(user => Number(user.id) === senderId);
        const isFile = message.message_type === "file" || Boolean(message.file_url);
        const preview = isFile ? `📎 ${message.file_name || "Sent a file or voice note"}` : (message.message || "New message");
        addAppNotification({
          type: "message",
          title: sender ? sender.username : "New message",
          body: String(preview).slice(0, 180),
          targetUserId: senderId
        });
      }

      if (sameOpenPrivateChat) displayMessage(message);
    }
  );


  socket.on(
    "message-deleted",
    ()=>{
      loadChatHistory();
    }
  );

  socket.on("message-edited", message => {
    if (!selectedUser || !message) return;
    const isCurrentChat =
      (Number(message.sender_id) === Number(currentUser.id) && Number(message.receiver_id) === Number(selectedUser.id)) ||
      (Number(message.sender_id) === Number(selectedUser.id) && Number(message.receiver_id) === Number(currentUser.id));
    if (isCurrentChat) loadChatHistory();
  });


  socket.on(
    "message-error",
    data=>{

      alert(
        data.error ||
        "Message failed"
      );

    }
  );


  socket.on(
    "messages-read",
    ()=>{
      document
        .querySelectorAll(
          ".readMark"
        )
        .forEach(
          mark=>{
            mark.textContent="✓✓";
          }
        );
    }
  );


  socket.on(
    "typing",
    data=>{

      if(
        selectedUser &&
        Number(
          data.senderId
        ) ===
        Number(
          selectedUser.id
        )
      ){

        document
          .getElementById(
            "typingIndicator"
          )
          .classList.toggle(
            "hidden",
            !data.typing
          );

      }

    }
  );


  socket.on(
    "friend-request",
    request => {
      loadRequests();
      const senderId = Number(request && request.sender_id);
      const sender = friends.find(user => Number(user.id) === senderId) || allUsers.find(user => Number(user.id) === senderId);
      addAppNotification({
        type: "friend-request",
        title: "New friend request",
        body: sender ? `${sender.username} wants to connect with you.` : `User ID ${senderId || "unknown"} wants to connect with you.`,
        targetUserId: senderId || null,
        targetTab: "requests"
      });
    }
  );


  socket.on(
    "friend-accepted",
    data => {
      loadFriends();
      loadUsers();
      const acceptedId = Number(data && data.userId);
      const friend = allUsers.find(user => Number(user.id) === acceptedId) || friends.find(user => Number(user.id) === acceptedId);
      addAppNotification({
        type: "friend-accepted",
        title: "Friend request accepted",
        body: friend ? `${friend.username} is now connected with you.` : `User ID ${acceptedId || "unknown"} is now your friend.`,
        targetUserId: acceptedId || null
      });
    }
  );


  socket.on("group-message", message => {
    if (!message || !currentUser) return;
    const senderId = Number(message.sender_id);
    const groupId = Number(message.group_id);
    const mine = senderId === Number(currentUser.id);
    const activeGroup = chatMode === "group" && selectedGroup && Number(selectedGroup.id) === groupId;
    if (!mine && (!activeGroup || document.hidden)) {
      const group = knownGroups.find(entry => Number(entry.id) === groupId);
      addAppNotification({
        type: "group-message",
        title: group ? group.name : "New group message",
        body: `User ${senderId}: ${message.message || "Sent a message"}`,
        targetGroupId: groupId
      });
    }
    if (activeGroup) displayGroupMessage(message);
  });

  socket.on("reaction-updated", ()=>{
    if(chatMode==="private" && selectedUser) loadChatHistory();
  });

  socket.on("friend-removed", ()=>{ loadFriends(); loadUsers(); });

  socket.on("status-created", () => { loadStatuses(); });
  socket.on("status-viewed", data => {
    if (data && currentUser && Number(data.viewerId) !== Number(currentUser.id)) loadStatuses();
  });
  socket.on("contact-blocked", data => {
    if (selectedUser && Number(data && data.userId) === Number(selectedUser.id)) {
      alert("This user has blocked you. You may not be able to send messages or calls.");
    }
  });

  /* CALL */

  socket.on(
    "incoming-call",
    data=>{

      const muteUnknown = localStorage.getItem("rtc_mute_unknown_calls") === "1";
      const callerId = Number(data.callerId || data.senderId || 0);
      const isFriend = Array.isArray(friends) && friends.some(f => Number(f.id) === callerId);
      if (muteUnknown && !isFriend) {
        if (data.callerId) {
          socket.emit("end-call", { receiverId: data.callerId, reason: "unknown-caller-muted" });
        }
        return;
      }

      incomingCallData =
        data;

      if (document.hidden) {
        addAppNotification({
          type: "call",
          title: `Incoming ${data.callType === "audio" ? "audio" : "video"} call`,
          body: `${data.callerName || "Someone"} is calling you.`,
          targetUserId: callerId || null
        });
      }

      document.getElementById(
        "callerText"
      ).textContent =
        (
          data.callerName ||
          "Someone"
        ) +
        " is calling (" +
        (
          data.callType ||
          "audio"
        ) +
        ")";

      document
        .getElementById(
          "incomingCall"
        )
        .classList.remove(
          "hidden"
        );

    }
  );


  socket.on(
    "call-offer",
    async data=>{

      pendingOffer =
        data.offer;

      incomingCallData =
        {
          ...(incomingCallData || {}),
          ...data
        };

      if(
        peerConnection &&
        selectedUser &&
        Number(
          selectedUser.id
        ) ===
        Number(
          data.callerId
        )
      ){

        await acceptRemoteOffer(
          data
        );

      }

    }
  );


  socket.on(
    "call-answer",
    async data=>{

      if(!peerConnection)
        return;

      try{

        await peerConnection
          .setRemoteDescription(
            new RTCSessionDescription(
              data.answer
            )
          );

        await flushIce();

      }catch(error){

        console.error(
          "Answer error:",
          error
        );

      }

    }
  );


  socket.on(
    "ice-candidate",
    async data=>{

      if(!data.candidate)
        return;

      if(
        peerConnection &&
        peerConnection.remoteDescription
      ){

        try{

          await peerConnection
            .addIceCandidate(
              new RTCIceCandidate(
                data.candidate
              )
            );

        }catch(error){

          console.error(
            error
          );

        }

      }else{

        iceQueue.push(
          data.candidate
        );

      }

    }
  );


  socket.on(
    "end-call",
    ()=>{
      closeCall();
    }
  );


  socket.on(
    "call-error",
    data=>{

      alert(
        data.error ||
        "Call failed"
      );

      closeCall();

    }
  );

}


/* =====================================================
   LOAD USERS
===================================================== */

async function loadUsers(
  search=""
){

  try{

    const response =
      await fetch(
        "/api/users?search=" +
        encodeURIComponent(
          search
        ),
        {
          headers:
            authHeaders()
        }
      );

    if(response.status===401){

      logout();

      return;
    }

    const data =
      await response.json();

    if(
      Array.isArray(data)
    ){

      allUsers =
        data;

      renderUsers();

    }

  }catch(error){

    console.error(
      "Users:",
      error
    );

  }

}


/* =====================================================
   SEARCH
===================================================== */

function setSidebarTab(tab){
  const allowed = ["chats", "status", "requests", "groups", "users"];
  const target = allowed.includes(tab) ? tab : "chats";

  document.querySelectorAll(".sideTab[data-tab]").forEach(button => {
    const active = button.dataset.tab === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  allowed.forEach(name => {
    const panel = document.getElementById(`sidebarPanel${name[0].toUpperCase()}${name.slice(1)}`);
    if (panel) panel.classList.toggle("active", name === target);
  });
  if (target === "status") { loadStatuses(); loadBlockedUsers(); }
}

function showMobileSidebar(){
  const app = document.getElementById("appScreen");
  if (app) app.classList.remove("mobile-chat-open");
  setSidebarTab("chats");
}

function enterConversationView(){
  if (window.matchMedia && window.matchMedia("(max-width: 760px)").matches) {
    document.getElementById("appScreen")?.classList.add("mobile-chat-open");
  }
}

function safeAvatarUrl(value) {
  if (!value || typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function avatarMarkup(label, avatarUrl, className = "contactAvatar") {
  const text = String(label || "?").trim();
  const initial = text ? Array.from(text)[0].toUpperCase() : "?";
  const src = safeAvatarUrl(avatarUrl);
  return `<span class="${className} avatarWithPhoto" aria-hidden="true"><span class="avatarInitial">${escapeHtml(initial)}</span>${src ? `<img class="avatarPhoto" src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>`;
}

function setAvatarInitial(elementId, label, avatarUrl = "") {
  const avatar = document.getElementById(elementId);
  if (!avatar) return;
  const text = String(label || "?").trim();
  const initial = text ? Array.from(text)[0].toUpperCase() : "?";
  const src = safeAvatarUrl(avatarUrl);
  avatar.replaceChildren();
  const initialNode = document.createElement("span");
  initialNode.className = "avatarInitial";
  initialNode.textContent = initial;
  avatar.appendChild(initialNode);
  if (src) {
    const image = document.createElement("img");
    image.className = "avatarPhoto";
    image.src = src;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.onerror = () => image.remove();
    avatar.appendChild(image);
  }
}

function openAvatarPicker() {
  const menu = document.getElementById("accountMenu");
  const trigger = document.getElementById("accountMenuToggle");
  if (menu) menu.classList.add("hidden");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  const input = document.getElementById("avatarFileInput");
  if (input) {
    input.value = "";
    input.click();
  }
}

async function uploadProfileAvatar(event) {
  const input = event && event.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    showAppToast({ title: "Unsupported image", body: "Choose a JPG, PNG, or WebP image." });
    input.value = "";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showAppToast({ title: "Image is too large", body: "Profile pictures must be 5 MB or smaller." });
    input.value = "";
    return;
  }
  if (!currentUser || !getToken()) {
    showAppToast({ title: "Please log in", body: "Log in again before changing your profile picture." });
    input.value = "";
    return;
  }

  const form = new FormData();
  form.append("avatar", file, file.name);
  showAppToast({ title: "Uploading profile photo", body: "Please wait…" });
  try {
    const response = await fetch("/api/profile/avatar", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const responseText = await response.text();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; }
    catch (_) {
      const preview = responseText.replace(/\s+/g, " ").trim().slice(0, 100);
      const responseKind = contentType.includes("text/html") || /^<!doctype html|^<html/i.test(responseText.trim())
        ? "HTML page"
        : (contentType || "unknown content type");
      throw new Error(`DP API did not return JSON (HTTP ${response.status}; ${responseKind}). This usually means the backend is older than the frontend or Render is starting a different server.js. Open /api/version and redeploy the matching project. ${preview ? `Response: ${preview}` : ""}`);
    }
    if (!response.ok || !data.user || !data.user.avatar_url) {
      const detail = data.error || `Upload failed with HTTP ${response.status}.`;
      throw new Error(detail);
    }

    currentUser = { ...currentUser, ...data.user };
    try { localStorage.setItem("rtc_user", JSON.stringify(currentUser)); } catch (_) {}
    setAvatarInitial("profileAvatar", currentUser.username, currentUser.avatar_url);

    const updateAvatar = user => Number(user && user.id) === Number(currentUser.id)
      ? { ...user, avatar_url: currentUser.avatar_url }
      : user;
    allUsers = allUsers.map(updateAvatar);
    friends = friends.map(updateAvatar);
    if (selectedUser && Number(selectedUser.id) === Number(currentUser.id)) selectedUser = updateAvatar(selectedUser);

    renderUsers();
    renderFriends();
    renderRequests();
    if (selectedUser && chatMode === "private") {
      setAvatarInitial("chatAvatar", selectedUser.username, selectedUser.avatar_url);
    }
    showAppToast({ title: "Profile picture updated", body: "Your DP is saved to your account." });
  } catch (error) {
    console.error("PROFILE AVATAR UPLOAD:", error);
    showAppToast({ title: "DP upload failed", body: error.message || "Please try again." });
  } finally {
    input.value = "";
  }
}

function searchUsers(){
  const search = document.getElementById("searchInput").value.trim();
  if (search) setSidebarTab("users");
  loadUsers(search);
}


/* =====================================================
   RENDER USERS
===================================================== */

function renderUsers(){

  const list =
    document.getElementById(
      "usersList"
    );

  list.innerHTML="";

  const visible =
    allUsers.filter(
      user =>
        Number(user.id) !==
        Number(currentUser.id)
    );

  if(!visible.length){

    list.innerHTML =
      `<div class="emptySide">
        No users found
      </div>`;

    return;
  }

  visible.forEach(
    user=>{

      const div =
        document.createElement(
          "div"
        );

      div.className =
        "userItem";

      const online =
        Boolean(user.online);

      const alreadyFriend =
        friends.some(
          f =>
            Number(f.id) ===
            Number(user.id)
        );

      div.innerHTML = `
        <div class="contactRow">
          ${avatarMarkup(user.username, user.avatar_url, "contactAvatar")}
          <span class="contactText">
            <strong>${escapeHtml(user.username)}</strong>
            <small>ID: ${user.id} · ${online ? "Online" : "Offline"}</small>
          </span>
          <span class="contactPresence ${online ? "isOnline" : "isOffline"}" title="${online ? "Online" : "Offline"}"></span>
        </div>
        <div class="itemButtons">
          <button class="smallBtn chatFriendBtn" onclick="event.stopPropagation();selectUserById(${user.id})">Chat</button>
          ${alreadyFriend
            ? `<span class="friendStatusTag">✓ Friend</span>`
            : `<button class="smallBtn addBtn" onclick="event.stopPropagation();sendFriendRequest(${user.id})">＋ Add</button>`}
        </div>
      `;

      div.onclick =
        ()=>selectUser(user);

      list.appendChild(
        div
      );

    }
  );

}


/* =====================================================
   SELECT USER
===================================================== */

async function selectUserById(
  id
){

  const user =
    allUsers.find(
      u =>
        Number(u.id) ===
        Number(id)
    );

  if(user){

    await selectUser(
      user
    );

    return;
  }

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
        Number(u.id) ===
        Number(id)
    );

  if(found)
    await selectUser(
      found
    );

}


async function selectUser(
  user
){

  chatMode = "private";
  const groupButton = document.getElementById("groupManageBtn");
  if (groupButton) groupButton.classList.add("hidden");
  const callButtons = document.querySelector(".callButtons");
  if (callButtons) callButtons.classList.remove("hidden");
  const contactMenu = document.querySelector(".contactOptionsWrap");
  if (contactMenu) contactMenu.classList.remove("hidden");
  selectedGroup = null;
  selectedUser =
    user;
  markTargetNotificationsRead("user", user.id);

  document.getElementById(
    "chatUserName"
  ).textContent =
    user.username;

  document.getElementById(
    "chatUserStatus"
  ).textContent =
    user.online
      ? "Online"
      : "Offline";

  setAvatarInitial("chatAvatar", user.username, user.avatar_url);
  selectedUser.isBlocked = blockedUserIds.has(Number(user.id));
  applyContactBlockState();
  enterConversationView();
  await loadPinnedMessages();
  await loadChatHistory();

}


/* =====================================================
   CONNECT USER
===================================================== */

async function connectUser(){

  const id =
    Number(
      document.getElementById(
        "connectUserId"
      ).value
    );

  if(!id){

    alert(
      "Enter a valid User ID"
    );

    return;
  }

  await selectUserById(
    id
  );

  document.getElementById(
    "connectUserId"
  ).value="";

}


/* =====================================================
   CHAT HISTORY
===================================================== */

async function loadChatHistory(){

  if(
    !currentUser ||
    !selectedUser
  )
    return;

  const box =
    document.getElementById(
      "messages"
    );

  box.innerHTML =
    `<div class="emptyChat">
      Loading messages...
    </div>`;

  try{

    const response =
      await fetch(
        `/api/messages/${currentUser.id}/${selectedUser.id}`,
        {
          headers:
            authHeaders()
        }
      );

    if(response.status===401){

      logout();

      return;
    }

    const messages =
      await response.json();

    await loadPinnedMessages();
    box.innerHTML="";

    if(
      !Array.isArray(messages) ||
      messages.length===0
    ){

      box.innerHTML =
        `<div class="emptyChat">
          No messages yet.
        </div>`;

    }else{

      messages.forEach(
        displayMessage
      );

    }

    scrollMessages();

    socket.emit(
      "messages-read",
      {
        senderId:
          selectedUser.id
      }
    );

  }catch(error){

    console.error(
      error
    );

    box.innerHTML =
      `<div class="emptyChat">
        Could not load messages.
      </div>`;

  }

}


/* =====================================================
   SEND MESSAGE
===================================================== */

function sendMessage(){

  const input = document.getElementById("messageInput");
  const message = input.value.trim();
  if (selectedUser && selectedUser.isBlocked) { alert("You must unblock this user before sending messages."); return; }
  if(!message) return;

  if(chatMode==="group" && selectedGroup){
    socket.emit("group-message",{groupId:selectedGroup.id,message});
    input.value="";
    stopTyping();
    return;
  }

  if(!selectedUser){ alert("Select a user first"); return; }

  socket.emit(
    "private-message",
    {
      senderId:
        currentUser.id,

      receiverId:
        selectedUser.id,

      message,

      messageType:
        "text"
    }
  );

  input.value="";

  stopTyping();

}


/* =====================================================
   ENTER
===================================================== */

function handleMessageKey(
  event
){

  if(
    event.key==="Enter" &&
    !event.shiftKey
  ){

    event.preventDefault();

    sendMessage();

  }

}


/* =====================================================
   DISPLAY MESSAGE
===================================================== */

function displayMessage(
  message
){

  const box =
    document.getElementById(
      "messages"
    );

  const empty =
    box.querySelector(
      ".emptyChat"
    );

  if(empty)
    empty.remove();

  const div =
    document.createElement(
      "div"
    );

  const mine =
    Number(
      message.sender_id
    ) ===
    Number(
      currentUser.id
    );

  if (message.id != null) messageCache.set(String(message.id), message);
  div.dataset.messageId = message.id || "";
  div.dataset.messageKind = (message.message_type === "file" || message.file_url) ? "file" : "text";

  div.className =
    "message " +
    (
      mine
        ? "mine"
        : "theirs"
    );

  let content="";

  if(
    message.is_deleted
  ){

    content =
      `<div style="opacity:.6;">
        Message deleted
      </div>`;

  }else if(
    message.message_type==="file" &&
    message.file_url &&
    /\.(webm|ogg|mp3|wav|m4a|aac)(\?|$)/i.test(message.file_url)
  ){

    content = `
      🎙️ Voice / audio
      <audio controls preload="none" src="${escapeAttribute(message.file_url)}" style="display:block;max-width:240px;margin-top:8px;"></audio>
    `;

  }else if(
    message.message_type==="file" &&
    message.file_url
  ){

    content = `
      📎
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
        ${escapeHtml(
          message.file_name ||
          "File"
        )}
      </a>
    `;

  }else{

    content =
      `<div style="white-space:pre-wrap;">
        ${escapeHtml(
          message.message || ""
        )}
      </div>`;

  }

  const time =
    message.created_at
      ? new Date(
          message.created_at
        ).toLocaleTimeString(
          [],
          {
            hour:"2-digit",
            minute:"2-digit"
          }
        )
      : "";

  const read =
    mine
      ? (
        message.is_read
          ? "✓✓"
          : "✓"
      )
      : "";
  const isPinned = message.id != null && pinnedMessageIds.has(String(message.id));

  div.innerHTML = `
    ${message.is_forwarded ? '<div class="messagePinnedLabel">↪ Forwarded</div>' : ''}
    ${isPinned ? '<div class="messagePinnedLabel">📌 Pinned for you</div>' : ''}
    ${content}
    ${message.id && !message.is_deleted ? `<div class="messageTools">
      <button class="reactionBtn" onclick="reactMessage(${message.id},'👍')">👍</button>
      <button class="reactionBtn" onclick="reactMessage(${message.id},'❤️')">❤️</button>
      <button class="reactionBtn" onclick="reactMessage(${message.id},'😂')">😂</button>
      <button class="reactionBtn" onclick="reactMessage(${message.id},'😮')">😮</button>
      <button class="reactionBtn" onclick="reactMessage(${message.id},'👏')">👏</button>
      <button class="reactionBtn" onclick="togglePinMessage(${message.id})" title="Pin for you">${isPinned ? '📌 Unpin' : '📌 Pin'}</button>
      <button class="reactionBtn" onclick="forwardMessage(${message.id})" title="Forward message">↗ Forward</button>
    </div>` : ""}

    <div class="messageTime">
      ${time}
      ${message.is_edited ? '<span style="opacity:.65;"> · edited</span>' : ''}

      <span class="readMark">
        ${read}
      </span>

      ${
        mine &&
        message.id &&
        !message.is_deleted
          ? `
            ${message.message_type !== "file" ? `<button class="deleteMessage" onclick="editMessage(${message.id})">Edit</button>` : ""}
            <button
              class="deleteMessage"
              onclick="deleteMessage(${message.id})"
            >
              Delete for everyone
            </button>
          `
          : ""
      }

    </div>
  `;

  box.appendChild(
    div
  );

  scrollMessages();

}


/* =====================================================
   DELETE
===================================================== */

async function deleteMessage(
  id
){

  if(
    !confirm(
      "Delete this message?"
    )
  )
    return;

  try{

    const response =
      await fetch(
        `/api/messages/${id}`,
        {
          method:"DELETE",
          headers:
            authHeaders()
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      alert(
        data.error ||
        "Delete failed"
      );

    }

  }catch(error){

    console.error(
      error
    );

  }

}



/* =====================================================
   FEATURE 1: EDIT MESSAGE (15-minute server rule)
===================================================== */
async function editMessage(id) {
  const msg = messageCache.get(String(id));
  if (!msg || Number(msg.sender_id) !== Number(currentUser.id)) return;
  if (msg.is_deleted || msg.message_type === "file") return alert("Only text messages can be edited.");
  const replacement = prompt("Edit message (available for 15 minutes after sending):", msg.message || "");
  if (replacement === null) return;
  const message = replacement.trim();
  if (!message || message.length > 4000) return alert("Message must be 1–4000 characters.");
  try {
    const r = await fetch(`/api/messages/${id}/edit`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    const d = await r.json();
    if (!r.ok) return alert(d.error || "Edit failed.");
    await loadChatHistory();
  } catch (e) {
    console.error(e);
    alert("Could not edit message.");
  }
}

/* =====================================================
   FEATURE 2: VOICE NOTES (browser MediaRecorder)
===================================================== */
async function toggleVoiceNote() {
  const button = document.getElementById("voiceNoteBtn");
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    button.textContent = "🎙️";
    button.style.background = "#2b2b2b";
    return;
  }
  if (!((chatMode === "private" && selectedUser) || (chatMode === "group" && selectedGroup))) {
    alert("Open a private chat or group before recording a voice note.");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    alert("Voice recording is not supported in this browser.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    voiceChunks = [];
    mediaRecorder.ondataavailable = event => { if (event.data && event.data.size) voiceChunks.push(event.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      if (!blob.size) return;
      if (blob.size > 25 * 1024 * 1024) return alert("Voice note is too large (max 25 MB).");
      await uploadVoiceBlob(blob);
    };
    mediaRecorder.start();
    button.textContent = "⏹ Stop";
    button.style.background = "#b91c1c";
  } catch (e) {
    console.error(e);
    alert("Microphone permission was not granted.");
  }
}

async function uploadVoiceBlob(blob) {
  if (!((chatMode === "private" && selectedUser) || (chatMode === "group" && selectedGroup))) return;
  const recordedMode = chatMode;
  const recipient = selectedUser;
  const group = selectedGroup;
  try {
    const form = new FormData();
    form.append("file", blob, `voice-note-${Date.now()}.webm`);
    const r = await fetch("/api/upload", { method: "POST", headers: authHeaders(), body: form });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Upload failed");
    if (recordedMode === "group" && group) {
      socket.emit("group-message", { groupId: group.id, message: "🎙️ Voice note", messageType: "file", fileName: d.file.name, fileUrl: d.file.url, filePath: d.file.path, fileSize: d.file.size });
    } else if (recordedMode === "private" && recipient) {
      socket.emit("private-message", { senderId: currentUser.id, receiverId: recipient.id, message: "🎙️ Voice note", messageType: "file", fileName: d.file.name, fileUrl: d.file.url, filePath: d.file.path, fileSize: d.file.size });
    }
  } catch (e) {
    console.error(e);
    alert(e.message || "Could not send voice note.");
  }
}

/* =====================================================
   FEATURE 3: BASIC APP LOCK (casual privacy only)
===================================================== */
async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function toggleChatLock() {
  const overlay = document.getElementById("chatLockOverlay");
  const existing = localStorage.getItem("rtc_app_lock_hash");
  if (!existing) {
    const pin = prompt("Create an app passcode (4+ characters). This is a basic screen lock, not account security:");
    if (!pin || pin.length < 4) return alert("Passcode must be at least 4 characters.");
    localStorage.setItem("rtc_app_lock_hash", await sha256Text(pin));
  }
  document.getElementById("chatUnlockPin").value = "";
  document.getElementById("chatUnlockError").textContent = "";
  overlay.classList.remove("hidden");
  overlay.style.display = "flex";
}
async function unlockChatApp() {
  const pin = document.getElementById("chatUnlockPin").value;
  const saved = localStorage.getItem("rtc_app_lock_hash");
  if (saved && await sha256Text(pin) === saved) {
    document.getElementById("chatLockOverlay").classList.add("hidden");
    document.getElementById("chatUnlockError").textContent = "";
  } else {
    document.getElementById("chatUnlockError").textContent = "Incorrect passcode.";
  }
}
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !document.getElementById("chatLockOverlay").classList.contains("hidden")) unlockChatApp();
});

/* =====================================================
   FEATURE 4: MUTE UNKNOWN CALLERS
===================================================== */
function saveMuteUnknownCalls() {
  const enabled = document.getElementById("muteUnknownCalls").checked;
  localStorage.setItem("rtc_mute_unknown_calls", enabled ? "1" : "0");
}
function restoreNewFeatureSettings() {
  const toggle = document.getElementById("muteUnknownCalls");
  if (toggle) toggle.checked = localStorage.getItem("rtc_mute_unknown_calls") === "1";
}
document.addEventListener("DOMContentLoaded", restoreNewFeatureSettings);

/* =====================================================
   FEATURE 5: FILTER VISIBLE MESSAGES
===================================================== */
function filterVisibleMessages(kind) {
  document.querySelectorAll("#messages .message").forEach(node => {
    const file = node.dataset.messageKind === "file";
    node.style.display = kind === "all" || (kind === "files" && file) || (kind === "text" && !file) ? "" : "none";
  });
  document.querySelectorAll(".filterChip").forEach(button => button.classList.remove("active"));
  const clicked = Array.from(document.querySelectorAll(".filterChip")).find(button => {
    const text = button.textContent.toLowerCase();
    return kind === "all" ? text.includes("all") : kind === "text" ? text === "text" : text.includes("files");
  });
  if (clicked) clicked.classList.add("active");
}

/* =====================================================
   FILE UPLOAD
===================================================== */

async function uploadFile(){

  const input =
    document.getElementById(
      "fileInput"
    );

  const file =
    input.files[0];

  if(!file)
    return;

  const privateTarget = chatMode === "private" && selectedUser;
  const groupTarget = chatMode === "group" && selectedGroup;
  if(!privateTarget && !groupTarget){
    alert("Open a private chat or group first.");
    input.value="";
    return;
  }

  if(
    file.size >
    100 * 1024 * 1024
  ){

    alert(
      "Maximum file size is 100 MB."
    );

    input.value="";

    return;
  }

  try{

    const form =
      new FormData();

    form.append(
      "file",
      file
    );

    const response =
      await fetch(
        "/api/upload",
        {
          method:"POST",
          headers:
            authHeaders(),
          body:form
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      alert(
        data.error ||
        "Upload failed"
      );

      return;
    }

    if (groupTarget) {
      socket.emit("group-message", {
        groupId: selectedGroup.id,
        message: "📎 " + data.file.name,
        messageType: "file",
        fileName: data.file.name,
        fileUrl: data.file.url,
        filePath: data.file.path,
        fileSize: data.file.size
      });
    } else {
      socket.emit("private-message", {
        senderId: currentUser.id,
        receiverId: selectedUser.id,
        message: "📎 " + data.file.name,
        messageType: "file",
        fileName: data.file.name,
        fileUrl: data.file.url,
        filePath: data.file.path,
        fileSize: data.file.size
      });
    }

  }catch(error){

    console.error(
      error
    );

    alert(
      "File upload failed"
    );

  }finally{

    input.value="";

  }

}


/* =====================================================
   GROUPS
===================================================== */
async function loadGroups(){
  try{
    const r=await fetch("/api/groups",{headers:authHeaders()});
    if(!r.ok) return;
    const groups=await r.json();
    knownGroups = Array.isArray(groups) ? groups : [];
    const list=document.getElementById("groupsList"); list.innerHTML="";
    if(!groups.length){list.innerHTML='<div class="emptySide">No groups yet</div>';return;}
    groups.forEach(g=>{const d=document.createElement("div");d.className="groupItem";d.innerHTML=`<div class="contactRow"><span class="contactAvatar groupAvatar" aria-hidden="true">♧</span><span class="contactText"><strong>${escapeHtml(g.name)}</strong><small>Group conversation</small></span><span class="groupChevron">›</span></div>`;d.onclick=()=>selectGroup(g);list.appendChild(d);});
  }catch(e){console.error("Groups:",e)}
}

async function createGroup(){
  const input=document.getElementById("groupNameInput"); const name=input.value.trim();
  if(!name) return;
  try{
    const r=await fetch("/api/groups",{method:"POST",headers:{...authHeaders(),"Content-Type":"application/json"},body:JSON.stringify({name})});
    const d=await r.json(); if(!r.ok){alert(d.error||"Group creation failed");return;}
    input.value=""; await loadGroups(); await selectGroup(d);
  }catch(e){console.error(e)}
}

async function addGroupMember(){
  if(chatMode!=="group" || !selectedGroup) return;
  const text=prompt(`Enter the user ID to add to “${selectedGroup.name}”. Only the group creator can add members.`);
  if(text===null) return;
  const userId=Number(String(text).trim());
  if(!Number.isInteger(userId)||userId<1) return alert("Enter a valid user ID.");
  try {
    const r=await fetch(`/api/groups/${selectedGroup.id}/members`,{method:"POST",headers:{...authHeaders(),"Content-Type":"application/json"},body:JSON.stringify({userId})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error||"Could not add member.");
    alert("Member added to group.");
    socket.emit("join-group",{groupId:selectedGroup.id});
  } catch(e) { alert(e.message||"Could not add member."); }
}

async function selectGroup(group){
  chatMode="group"; selectedGroup=group; selectedUser=null; applyContactBlockState(); pinnedMessageIds = new Set();
  const groupButton = document.getElementById("groupManageBtn");
  if (groupButton) groupButton.classList.remove("hidden");
  const callButtons = document.querySelector(".callButtons");
  if (callButtons) callButtons.classList.add("hidden");
  const contactMenu = document.querySelector(".contactOptionsWrap");
  if (contactMenu) contactMenu.classList.add("hidden");
  markTargetNotificationsRead("group", group.id);
  document.getElementById("chatUserName").textContent="👥 "+group.name;
  document.getElementById("chatUserStatus").textContent="Group chat";
  setAvatarInitial("chatAvatar", group.name);
  enterConversationView();
  socket.emit("join-group",{groupId:group.id});
  const box=document.getElementById("messages"); box.innerHTML='<div class="emptyChat">Loading group messages...</div>';
  try{
    const r=await fetch(`/api/groups/${group.id}/messages`,{headers:authHeaders()}); const msgs=await r.json(); box.innerHTML="";
    if(!msgs.length){box.innerHTML='<div class="emptyChat">No group messages yet.</div>';return;}
    msgs.forEach(displayGroupMessage); scrollMessages();
  }catch(e){box.innerHTML='<div class="emptyChat">Could not load group messages.</div>'}
}

function displayGroupMessage(message){
  const box=document.getElementById("messages"); const empty=box.querySelector(".emptyChat"); if(empty) empty.remove();
  const div=document.createElement("div"); const mine=Number(message.sender_id)===Number(currentUser.id); div.className="message "+(mine?"mine":"theirs");
  div.dataset.messageKind = message.message_type === "file" || message.file_url ? "file" : "text";
  const time=message.created_at?new Date(message.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):"";
  let body = `<div style="white-space:pre-wrap;">${escapeHtml(message.message||"")}</div>`;
  if (message.message_type === "file" && message.file_url && /\.(webm|ogg|mp3|wav|m4a|aac)(\?|$)/i.test(message.file_url)) {
    body = `<div>🎙️ ${escapeHtml(message.file_name || "Voice / audio")}</div><audio controls preload="none" src="${escapeAttribute(message.file_url)}" style="display:block;max-width:240px;margin-top:8px;"></audio>`;
  } else if (message.message_type === "file" && message.file_url) {
    body = `<div>📎 <a href="${escapeAttribute(message.file_url)}" target="_blank" rel="noopener">${escapeHtml(message.file_name || "File")}</a></div>`;
  }
  div.innerHTML=`<div style="font-size:11px;opacity:.75;margin-bottom:3px;">User ${Number(message.sender_id)}</div>${body}<div class="messageTime">${time}</div>`;
  box.appendChild(div); scrollMessages();
}

async function reactMessage(messageId,emoji){
  try{
    const r=await fetch(`/api/messages/${messageId}/reactions`,{method:"POST",headers:{...authHeaders(),"Content-Type":"application/json"},body:JSON.stringify({emoji})});
    if(!r.ok){const d=await r.json();alert(d.error||"Reaction failed");return;}
    if(selectedUser) loadChatHistory();
  }catch(e){console.error(e)}
}

async function searchMessages(){
  const q=document.getElementById("messageSearchInput").value.trim();
  if(chatMode==="group" && selectedGroup){
    try {
      const route = q ? `/api/groups/${selectedGroup.id}/messages/search?q=${encodeURIComponent(q)}` : `/api/groups/${selectedGroup.id}/messages`;
      const r=await fetch(route,{headers:authHeaders()}); const data=await r.json(); const box=document.getElementById("messages"); box.innerHTML="";
      if(!r.ok) throw new Error(data.error||"Group search failed");
      if(!data.length){box.innerHTML='<div class="emptyChat">No matching messages.</div>';return;}
      data.forEach(displayGroupMessage); scrollMessages();
    } catch (e) { console.error(e); alert(e.message||"Group search failed."); }
    return;
  }
  if(chatMode!=="private" || !selectedUser) return;
  if(!q){await loadChatHistory();return;}
  try{
    const r=await fetch(`/api/messages/search?q=${encodeURIComponent(q)}&userId=${selectedUser.id}`,{headers:authHeaders()});
    const data=await r.json(); const box=document.getElementById("messages"); box.innerHTML="";
    if(!r.ok) throw new Error(data.error||"Search failed");
    if(!data.length){box.innerHTML='<div class="emptyChat">No matching messages.</div>';return;}
    data.reverse().forEach(displayMessage); scrollMessages();
  }catch(e){console.error(e); alert(e.message||"Search failed.")}
}
function handleMessageSearch(event){if(event.key==="Enter"){event.preventDefault();searchMessages();}}

/* =====================================================
   STATUSES / STORIES, BLOCK & REPORT, PIN, FORWARD, EXPORT
===================================================== */
function setStatusComposerMessage(message, kind = "info") {
  const node = document.getElementById("statusComposerMessage");
  if (!node) return;
  node.textContent = message || "";
  node.dataset.kind = kind;
}

function statusAge(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleString();
}

async function loadStatuses() {
  const ownList = document.getElementById("myStatusesList");
  const friendsList = document.getElementById("friendStatusesList");
  if (!ownList || !friendsList || !currentUser || !getToken()) return;
  try {
    const response = await fetch("/api/statuses", { headers: authHeaders() });
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      ownList.innerHTML = `<div class="emptySide">${escapeHtml(data.error || "Could not load statuses")}</div>`;
      friendsList.innerHTML = "";
      return;
    }
    statusItems = Array.isArray(data) ? data : [];
    renderStatuses();
  } catch (error) {
    console.warn("LOAD STATUSES:", error);
    ownList.innerHTML = '<div class="emptySide">Could not connect to status service.</div>';
  }
}

function renderStatuses() {
  const ownList = document.getElementById("myStatusesList");
  const friendsList = document.getElementById("friendStatusesList");
  if (!ownList || !friendsList) return;
  const own = statusItems.filter(item => Number(item.user_id) === Number(currentUser && currentUser.id));
  const others = statusItems.filter(item => Number(item.user_id) !== Number(currentUser && currentUser.id));
  ownList.innerHTML = own.length ? "" : '<div class="emptySide">You have not shared a status yet.</div>';
  friendsList.innerHTML = others.length ? "" : '<div class="emptySide">No friends have shared a status yet.</div>';
  const createRow = (item, isOwn) => {
    const row = document.createElement("div");
    row.className = `statusRow ${item.viewed_by_me ? "statusSeen" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "statusOpenButton";
    const ring = document.createElement("span");
    ring.className = "statusRing";
    ring.innerHTML = avatarMarkup(item.username || "?", item.avatar_url, "contactAvatar");
    const info = document.createElement("span");
    info.className = "statusInfo";
    const name = document.createElement("strong");
    name.textContent = isOwn ? "My status" : (item.username || "Friend");
    const summary = document.createElement("small");
    summary.textContent = `${item.media_type && item.media_type !== "text" ? "Photo/video · " : ""}${statusAge(item.created_at)}${isOwn ? ` · ${Number(item.view_count || 0)} views` : (item.viewed_by_me ? " · Viewed" : " · New")}`;
    info.append(name, summary);
    button.append(ring, info);
    button.addEventListener("click", () => openStatusViewer(item.id));
    row.appendChild(button);
    if (isOwn) {
      const del = document.createElement("button");
      del.type = "button"; del.className = "statusDeleteBtn"; del.textContent = "Delete";
      del.addEventListener("click", event => { event.stopPropagation(); deleteStatus(item.id); });
      row.appendChild(del);
    }
    return row;
  };
  own.forEach(item => ownList.appendChild(createRow(item, true)));
  others.forEach(item => friendsList.appendChild(createRow(item, false)));
}

async function publishStatus() {
  const textInput = document.getElementById("statusText");
  const fileInput = document.getElementById("statusMediaInput");
  const button = document.getElementById("publishStatusBtn");
  if (!currentUser || !getToken()) return setStatusComposerMessage("Log in before posting a status.", "error");
  const content = String(textInput && textInput.value || "").trim();
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!content && !file) return setStatusComposerMessage("Write something or choose a photo/video.", "error");
  if (content.length > 700) return setStatusComposerMessage("Keep status text under 700 characters.", "error");
  if (file && file.size > 20 * 1024 * 1024) return setStatusComposerMessage("Photo/video must be 20 MB or smaller.", "error");
  const form = new FormData();
  form.append("content", content);
  if (file) form.append("media", file);
  if (button) { button.disabled = true; button.textContent = "Posting…"; }
  setStatusComposerMessage("Uploading status…");
  try {
    const response = await fetch("/api/statuses", { method: "POST", headers: authHeaders(), body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Status could not be posted.");
    if (textInput) textInput.value = "";
    if (fileInput) fileInput.value = "";
    const mediaName = document.getElementById("statusMediaName");
    if (mediaName) mediaName.textContent = "No media selected · max 20 MB";
    setStatusComposerMessage("Status shared. It expires after 24 hours.", "success");
    await loadStatuses();
  } catch (error) {
    setStatusComposerMessage(error.message || "Status upload failed.", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "Share status"; }
  }
}

async function openStatusViewer(statusId) {
  const item = statusItems.find(status => Number(status.id) === Number(statusId));
  if (!item) return;
  const name = document.getElementById("statusViewerName");
  const time = document.getElementById("statusViewerTime");
  const avatar = document.getElementById("statusViewerAvatar");
  const content = document.getElementById("statusViewerContent");
  const views = document.getElementById("statusViewerViews");
  if (name) name.textContent = Number(item.user_id) === Number(currentUser.id) ? "My status" : item.username;
  if (time) time.textContent = `${statusAge(item.created_at)} · expires ${new Date(item.expires_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
  if (avatar) { avatar.className = "avatar"; avatar.innerHTML = avatarMarkup(item.username || "?", item.avatar_url, "contactAvatar"); }
  if (content) {
    content.innerHTML = "";
    if (item.media_url && String(item.media_type).startsWith("image/")) {
      const img = document.createElement("img"); img.className = "statusViewerMedia"; img.src = safeAvatarUrl(item.media_url); img.alt = "Status photo"; content.appendChild(img);
    } else if (item.media_url && String(item.media_type).startsWith("video/")) {
      const video = document.createElement("video"); video.className = "statusViewerMedia video"; video.src = safeAvatarUrl(item.media_url); video.controls = true; video.playsInline = true; content.appendChild(video);
    }
    if (item.content) { const txt = document.createElement("div"); txt.className = "statusViewerText"; txt.textContent = item.content; content.appendChild(txt); }
  }
  if (views) views.textContent = Number(item.user_id) === Number(currentUser.id) ? `${Number(item.view_count || 0)} views` : "Visible to friends only";
  const dialog = document.getElementById("statusViewerDialog");
  if (dialog && typeof dialog.showModal === "function") dialog.showModal(); else dialog?.setAttribute("open", "open");
  if (Number(item.user_id) !== Number(currentUser.id) && !item.viewed_by_me) {
    try {
      const r = await fetch(`/api/statuses/${item.id}/view`, { method: "POST", headers: authHeaders() });
      if (r.ok) { item.viewed_by_me = true; }
    } catch (error) { console.warn("STATUS VIEW:", error); }
  }
  if (Number(item.user_id) === Number(currentUser.id)) await loadStatuses();
}

function closeStatusViewer() {
  const dialog = document.getElementById("statusViewerDialog");
  if (dialog && typeof dialog.close === "function") dialog.close(); else dialog?.removeAttribute("open");
  const content = document.getElementById("statusViewerContent");
  if (content) content.innerHTML = "";
}

async function deleteStatus(statusId) {
  if (!confirm("Delete this status for everyone?")) return;
  try {
    const response = await fetch(`/api/statuses/${statusId}`, { method: "DELETE", headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not delete status.");
    await loadStatuses();
  } catch (error) { alert(error.message || "Could not delete status."); }
}

async function loadBlockedUsers() {
  const list = document.getElementById("blockedUsersList");
  if (!list || !currentUser || !getToken()) return;
  try {
    const response = await fetch("/api/blocks", { headers: authHeaders() });
    const data = await response.json().catch(() => []);
    if (!response.ok) { list.innerHTML = `<div class="emptySide">${escapeHtml(data.error || "Block list unavailable")}</div>`; return; }
    const rows = Array.isArray(data) ? data : [];
    blockedUserIds = new Set(rows.map(row => Number(row.blocked_id)));
    list.innerHTML = rows.length ? "" : '<div class="emptySide">No blocked users</div>';
    rows.forEach(row => {
      const user = row.user || {};
      const line = document.createElement("div"); line.className = "statusRow";
      line.innerHTML = `${avatarMarkup(user.username || `User ${row.blocked_id}`, user.avatar_url, "contactAvatar")}<span class="statusInfo"><strong>${escapeHtml(user.username || `User ${row.blocked_id}`)}</strong><small>Blocked contact</small></span><button class="unblockBtn" type="button">Unblock</button>`;
      line.querySelector("button").addEventListener("click", () => unblockUser(row.blocked_id));
      list.appendChild(line);
    });
    if (selectedUser) { selectedUser.isBlocked = blockedUserIds.has(Number(selectedUser.id)); applyContactBlockState(); }
  } catch (error) { console.warn("BLOCK LIST:", error); list.innerHTML = '<div class="emptySide">Could not load block list.</div>'; }
}

function applyContactBlockState() {
  const blocked = Boolean(selectedUser && selectedUser.isBlocked && chatMode === "private");
  ["messageInput", "fileInput", "voiceNoteBtn"].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = blocked; });
  document.querySelectorAll(".messageBar .sendBtn").forEach(el => { el.disabled = blocked; });
  document.querySelectorAll(".callBtn").forEach(el => { el.disabled = blocked; el.title = blocked ? "Unblock this contact before calling" : el.title; });
  const menuItem = document.getElementById("blockContactMenuItem");
  if (menuItem) menuItem.textContent = blocked ? "✅ Unblock contact" : "🚫 Block contact";
  const status = document.getElementById("chatUserStatus");
  if (blocked && status) status.textContent = "Blocked · unblock to message or call";
  else if (selectedUser && status) status.textContent = selectedUser.online ? "Online" : "Offline";
}

function toggleContactOptions(event) {
  event?.stopPropagation();
  if (!selectedUser || chatMode !== "private") return alert("Open a private chat first.");
  const menu = document.getElementById("contactOptionsMenu");
  const button = document.getElementById("contactOptionsToggle");
  menu?.classList.toggle("hidden");
  button?.setAttribute("aria-expanded", menu && !menu.classList.contains("hidden") ? "true" : "false");
}

async function toggleBlockSelectedUser() {
  if (!selectedUser || chatMode !== "private") return;
  const target = selectedUser;
  const blocked = blockedUserIds.has(Number(target.id));
  const actionText = blocked ? "Unblock" : "Block";
  if (!confirm(`${actionText} @${target.username}? ${blocked ? "They may be able to message and call you again." : "This removes the friend connection and prevents new messages and calls between you."}`)) return;
  try {
    const response = await fetch(blocked ? `/api/blocks/${target.id}` : "/api/blocks", {
      method: blocked ? "DELETE" : "POST",
      headers: { ...authHeaders(), ...(blocked ? {} : {"Content-Type":"application/json"}) },
      ...(blocked ? {} : { body: JSON.stringify({ blockedUserId: target.id }) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${actionText} failed.`);
    if (blocked) blockedUserIds.delete(Number(target.id)); else blockedUserIds.add(Number(target.id));
    selectedUser.isBlocked = !blocked;
    applyContactBlockState();
    document.getElementById("contactOptionsMenu")?.classList.add("hidden");
    await Promise.all([loadBlockedUsers(), loadFriends(), loadUsers(), loadRequests()]);
    alert(blocked ? "Contact unblocked." : "Contact blocked.");
  } catch (error) { alert(error.message || `${actionText} failed.`); }
}

async function unblockUser(userId) {
  const id = Number(userId);
  try {
    const response = await fetch(`/api/blocks/${id}`, { method: "DELETE", headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not unblock user.");
    blockedUserIds.delete(id);
    if (selectedUser && Number(selectedUser.id) === id) { selectedUser.isBlocked = false; applyContactBlockState(); }
    await Promise.all([loadBlockedUsers(), loadUsers(), loadFriends()]);
  } catch (error) { alert(error.message || "Could not unblock user."); }
}

async function reportSelectedUser() {
  if (!selectedUser || chatMode !== "private") return;
  const target = selectedUser;
  const reasonText = prompt("Report reason: spam, harassment, impersonation, inappropriate-content, other", "other");
  if (reasonText === null) return;
  const reason = reasonText.trim().toLowerCase();
  const details = prompt("Add optional details (do not include private passwords or secrets):", "") || "";
  try {
    const response = await fetch("/api/reports", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ reportedUserId: target.id, reason, details })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Report failed.");
    document.getElementById("contactOptionsMenu")?.classList.add("hidden");
    alert("Report submitted. Thanks for helping keep RealTimeChat safer.");
  } catch (error) { alert(error.message || "Report failed."); }
}

async function loadPinnedMessages() {
  if (!selectedUser || !currentUser || chatMode !== "private") { pinnedMessageIds = new Set(); return; }
  try {
    const response = await fetch(`/api/pins/${selectedUser.id}`, { headers: authHeaders() });
    const data = await response.json().catch(() => []);
    if (response.ok && Array.isArray(data)) pinnedMessageIds = new Set(data.map(id => String(id)));
  } catch (error) { console.warn("PIN LIST:", error); }
}

async function togglePinMessage(messageId) {
  const isPinned = pinnedMessageIds.has(String(messageId));
  try {
    const response = await fetch(`/api/messages/${messageId}/pin`, { method: isPinned ? "DELETE" : "POST", headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not update pin.");
    if (isPinned) pinnedMessageIds.delete(String(messageId)); else pinnedMessageIds.add(String(messageId));
    await loadChatHistory();
  } catch (error) { alert(error.message || "Could not update pin."); }
}

async function forwardMessage(messageId) {
  const message = messageCache.get(String(messageId));
  if (!message) return;
  const recipientText = prompt("Enter the recipient's User ID (shown in their profile):");
  if (recipientText === null) return;
  const receiverId = Number(recipientText.trim());
  if (!Number.isInteger(receiverId) || receiverId < 1 || receiverId === Number(currentUser.id)) return alert("Enter a valid recipient User ID.");
  if (!confirm(`Forward this message to User ID ${receiverId}?`)) return;
  try {
    const response = await fetch(`/api/messages/${messageId}/forward`, {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ receiverId })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not forward message.");
    alert("Message forwarded.");
  } catch (error) { alert(error.message || "Could not forward message."); }
}

async function exportCurrentChat() {
  if (!selectedUser || chatMode !== "private") return alert("Open a private chat first.");
  try {
    const response = await fetch(`/api/messages/${currentUser.id}/${selectedUser.id}`, { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not export chat.");
    const lines = (Array.isArray(data) ? data : []).map(message => {
      const time = message.created_at ? new Date(message.created_at).toLocaleString() : "";
      const sender = Number(message.sender_id) === Number(currentUser.id) ? "You" : selectedUser.username;
      const body = message.is_deleted ? "[Message deleted]" : (message.message || message.file_name || message.file_url || "[Attachment]");
      return `[${time}] ${sender}: ${body}${message.is_edited ? " (edited)" : ""}${message.is_forwarded ? " (forwarded)" : ""}`;
    });
    const blob = new Blob([`RealTimeChat conversation with ${selectedUser.username}\n\n${lines.join("\n")}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = `RealTimeChat-${String(selectedUser.username).replace(/[^a-z0-9_-]/gi,"_")}-chat.txt`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    document.getElementById("contactOptionsMenu")?.classList.add("hidden");
  } catch (error) { alert(error.message || "Could not export chat."); }
}

/* =====================================================
   FRIEND REQUEST
===================================================== */

async function sendFriendRequest(
  receiverId
){

  try{

    const response =
      await fetch(
        "/api/friends/request",
        {
          method:"POST",
          headers:{
            ...authHeaders(),
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            receiverId
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      alert(
        data.error ||
        "Could not send request"
      );

      return;
    }

    alert(
      "✅ Friend request sent"
    );

    loadUsers();

  }catch(error){

    console.error(
      error
    );

  }

}


/* =====================================================
   REQUESTS
===================================================== */

async function loadRequests(){

  try{

    const response =
      await fetch(
        "/api/friends/requests",
        {
          headers:
            authHeaders()
        }
      );

    if(!response.ok)
      return;

    requests =
      await response.json();

    renderRequests();

  }catch(error){

    console.error(
      error
    );

  }

}


function renderRequests(){

  const list =
    document.getElementById(
      "requestsList"
    );

  const badge =
    document.getElementById(
      "requestBadge"
    );

  list.innerHTML="";

  if(!requests.length){

    badge.classList.add(
      "hidden"
    );

    list.innerHTML =
      `<div class="emptySide">
        No pending requests
      </div>`;

    return;
  }

  badge.classList.remove(
    "hidden"
  );

  badge.textContent =
    requests.length;

  requests.forEach(
    request=>{

      const div =
        document.createElement(
          "div"
        );

      div.className =
        "requestItem";

      div.innerHTML = `
        <div class="requestRow">
          ${avatarMarkup((request.sender && request.sender.username) || request.sender_name || `User ${request.sender_id}`, (request.sender && request.sender.avatar_url) || request.avatar_url, "contactAvatar")}
          <span class="contactText"><strong>${escapeHtml((request.sender && request.sender.username) || request.sender_name || `User ID: ${request.sender_id}`)}</strong><small>Wants to connect with you</small></span>
        </div>
        <div class="itemButtons">
          <button class="smallBtn acceptBtn" onclick="respondRequest(${request.id}, 'accept')">✓ Accept</button>
          <button class="smallBtn rejectBtn" onclick="respondRequest(${request.id}, 'reject')">✕ Reject</button>
        </div>
      `;

      list.appendChild(
        div
      );

    }
  );

}


/* =====================================================
   ACCEPT / REJECT
===================================================== */

async function respondRequest(
  requestId,
  action
){

  try{

    const response =
      await fetch(
        "/api/friends/respond",
        {
          method:"POST",
          headers:{
            ...authHeaders(),
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            requestId,
            action
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok){

      alert(
        data.error ||
        "Request failed"
      );

      return;
    }

    await loadRequests();

    await loadFriends();

    await loadUsers();

  }catch(error){

    console.error(
      error
    );

  }

}


/* =====================================================
   FRIENDS
===================================================== */

async function loadFriends(){

  try{

    const response =
      await fetch(
        "/api/friends",
        {
          headers:
            authHeaders()
        }
      );

    if(!response.ok)
      return;

    friends =
      await response.json();

    renderFriends();

  }catch(error){

    console.error(
      error
    );

  }

}


function renderFriends(){

  const list =
    document.getElementById(
      "friendsList"
    );

  list.innerHTML="";

  if(!friends.length){

    list.innerHTML =
      `<div class="emptySide">
        No friends yet
      </div>`;

    return;
  }

  friends.forEach(
    friend=>{

      const div =
        document.createElement(
          "div"
        );

      div.className =
        "friendItem";

      div.innerHTML = `
        <div class="contactRow" onclick="selectUserById(${friend.id})" style="cursor:pointer;">
          ${avatarMarkup(friend.username, friend.avatar_url, "contactAvatar")}
          <span class="contactText"><strong>${escapeHtml(friend.username)}</strong><small>${friend.online ? "Online now" : "Offline"}</small></span>
          <span class="contactPresence ${friend.online ? "isOnline" : "isOffline"}" title="${friend.online ? "Online" : "Offline"}"></span>
        </div>
        <div class="itemButtons">
          <button class="smallBtn rejectBtn" onclick="event.stopPropagation();removeFriend(${friend.id})">Remove friend</button>
        </div>
      `;

      list.appendChild(
        div
      );

    }
  );

}


async function removeFriend(friendId){
  if(!confirm("Remove this friend?")) return;
  try{const r=await fetch(`/api/friends/${friendId}`,{method:"DELETE",headers:authHeaders()});const d=await r.json();if(!r.ok){alert(d.error||"Could not remove friend");return;}await loadFriends();await loadUsers();}catch(e){console.error(e)}
}

/* =====================================================
   TYPING
===================================================== */

function typingStart(){

  if(
    !socket ||
    !selectedUser
  )
    return;

  if(!currentlyTyping){

    currentlyTyping=true;

    socket.emit(
      "typing",
      {
        receiverId:
          selectedUser.id,
        typing:true
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


function stopTyping(){

  clearTimeout(
    typingTimer
  );

  if(
    !currentlyTyping ||
    !selectedUser
  )
    return;

  currentlyTyping=false;

  socket.emit(
    "typing",
    {
      receiverId:
        selectedUser.id,
      typing:false
    }
  );

  document
    .getElementById(
      "typingIndicator"
    )
    .classList.add(
      "hidden"
    );

}


/* =====================================================
   CALL
===================================================== */

async function startAudioCall(){

  await startCall(
    "audio"
  );

}


async function startVideoCall(){

  await startCall(
    "video"
  );

}


async function startCall(
  callType
){

  if(!selectedUser){

    alert(
      "Select a user first"
    );

    return;
  }

  try{

    localStream =
      await navigator
        .mediaDevices
        .getUserMedia({
          audio:true,
          video:
            callType ===
            "video"
        });

    showLocalStream();

    peerConnection =
      createPeerConnection(
        selectedUser.id
      );

    localStream
      .getTracks()
      .forEach(
        track=>{
          peerConnection.addTrack(
            track,
            localStream
          );
        }
      );

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

  }catch(error){

    console.error(
      error
    );

    alert(
      "Microphone/camera permission is required."
    );

    closeCall();

  }

}


/* =====================================================
   PEER CONNECTION
===================================================== */

function createPeerConnection(
  remoteUserId
){

  const pc =
    new RTCPeerConnection(
      rtcConfig
    );

  pc.onicecandidate =
    event=>{

      if(
        event.candidate &&
        socket
      ){

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
    event=>{

      const remote =
        document.getElementById(
          "remoteVideo"
        );

      if(
        event.streams &&
        event.streams[0]
      ){

        remote.srcObject =
          event.streams[0];

      }

    };


  pc.onconnectionstatechange =
    ()=>{

      if(
        pc.connectionState ===
        "failed" ||
        pc.connectionState ===
        "closed"
      ){

        closeCall();

      }

    };


  return pc;

}


/* =====================================================
   ACCEPT CALL
===================================================== */

async function acceptCall(){

  document
    .getElementById(
      "incomingCall"
    )
    .classList.add(
      "hidden"
    );

  if(!incomingCallData)
    return;

  const data =
    incomingCallData;

  selectedUser = {
    id:
      data.callerId,

    username:
      data.callerName ||
      "Caller"
  };

  document.getElementById(
    "chatUserName"
  ).textContent =
    selectedUser.username;

  try{

    localStream =
      await navigator
        .mediaDevices
        .getUserMedia({
          audio:true,

          video:
            data.callType ===
            "video"
        });

    showLocalStream();

    peerConnection =
      createPeerConnection(
        data.callerId
      );

    localStream
      .getTracks()
      .forEach(
        track=>{
          peerConnection.addTrack(
            track,
            localStream
          );
        }
      );

    const offer =
      data.offer ||
      pendingOffer;

    if(offer){

      await acceptRemoteOffer({
        ...data,
        offer
      });

    }

  }catch(error){

    console.error(
      error
    );

    alert(
      "Could not access microphone/camera."
    );

    closeCall();

  }

}


/* =====================================================
   REMOTE OFFER
===================================================== */

async function acceptRemoteOffer(
  data
){

  if(!peerConnection)
    return;

  try{

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
          data.callerId,

        answer
      }
    );

    pendingOffer =
      null;

    await flushIce();

  }catch(error){

    console.error(
      "Remote offer:",
      error
    );

  }

}


async function flushIce(){

  if(
    !peerConnection ||
    !peerConnection.remoteDescription
  )
    return;

  while(
    iceQueue.length
  ){

    const candidate =
      iceQueue.shift();

    try{

      await peerConnection
        .addIceCandidate(
          new RTCIceCandidate(
            candidate
          )
        );

    }catch(error){

      console.error(
        error
      );

    }

  }

}


/* =====================================================
   REJECT
===================================================== */

function rejectCall(){

  document
    .getElementById(
      "incomingCall"
    )
    .classList.add(
      "hidden"
    );

  incomingCallData =
    null;

  pendingOffer =
    null;

}


/* =====================================================
   VIDEO
===================================================== */

function showLocalStream(){

  document.getElementById(
    "localVideo"
  ).srcObject =
    localStream;

  document
    .getElementById(
      "videoPanel"
    )
    .classList.remove(
      "hidden"
    );

}


function toggleMute(){

  if(!localStream)
    return;

  localStream
    .getAudioTracks()
    .forEach(
      track=>{
        track.enabled =
          !track.enabled;
      }
    );

}


function toggleCamera(){

  if(!localStream)
    return;

  localStream
    .getVideoTracks()
    .forEach(
      track=>{
        track.enabled =
          !track.enabled;
      }
    );

}


/* =====================================================
   SCREEN SHARE
===================================================== */

async function shareScreen(){

  if(!selectedUser){

    alert(
      "Select a user first"
    );

    return;
  }

  if(!peerConnection){

    alert(
      "Start a video call first."
    );

    return;
  }

  try{

    const screenStream =
      await navigator
        .mediaDevices
        .getDisplayMedia({
          video:true,
          audio:true
        });

    const screenTrack =
      screenStream
        .getVideoTracks()[0];

    const sender =
      peerConnection
        .getSenders()
        .find(
          s =>
            s.track &&
            s.track.kind ===
            "video"
        );

    if(sender){

      await sender
        .replaceTrack(
          screenTrack
        );

    }

    document.getElementById(
      "localVideo"
    ).srcObject =
      screenStream;

    screenTrack.onended =
      async ()=>{

        const camera =
          localStream
            ?.getVideoTracks()[0];

        if(
          camera &&
          sender
        ){

          await sender
            .replaceTrack(
              camera
            );

        }

        if(localStream){

          document.getElementById(
            "localVideo"
          ).srcObject =
            localStream;

        }

      };

  }catch(error){

    console.error(
      "Screen share:",
      error
    );

  }

}


/* =====================================================
   END CALL
===================================================== */

function endCall(){

  if(
    selectedUser &&
    socket
  ){

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


function closeCall(){

  if(peerConnection){

    peerConnection.close();

    peerConnection =
      null;

  }

  if(localStream){

    localStream
      .getTracks()
      .forEach(
        track=>{
          track.stop();
        }
      );

    localStream =
      null;

  }

  iceQueue=[];

  pendingOffer=null;

  document.getElementById(
    "localVideo"
  ).srcObject=null;

  document.getElementById(
    "remoteVideo"
  ).srcObject=null;

  document
    .getElementById(
      "videoPanel"
    )
    .classList.add(
      "hidden"
    );

}


/* =====================================================
   ACCOUNT OPTIONS + PERMANENT DELETION
===================================================== */

function toggleAccountMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("accountMenu");
  const trigger = document.getElementById("accountMenuToggle");
  if (!menu || !trigger) return;
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

document.addEventListener("click", event => {
  const menu = document.getElementById("accountMenu");
  const trigger = document.getElementById("accountMenuToggle");
  if (menu && trigger && !event.target.closest(".profileActions")) {
    menu.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  }
});

function openDeleteAccountDialog() {
  const menu = document.getElementById("accountMenu");
  const trigger = document.getElementById("accountMenuToggle");
  if (menu) menu.classList.add("hidden");
  if (trigger) trigger.setAttribute("aria-expanded", "false");

  const dialog = document.getElementById("deleteAccountDialog");
  const password = document.getElementById("deleteAccountPassword");
  const confirmText = document.getElementById("deleteAccountConfirmText");
  const error = document.getElementById("deleteAccountError");
  if (!dialog) return;

  if (password) password.value = "";
  if (confirmText) confirmText.value = "";
  if (error) {
    error.textContent = "";
    error.classList.add("hidden");
  }
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "open");
  window.setTimeout(() => password && password.focus(), 50);
}

function closeDeleteAccountDialog() {
  const dialog = document.getElementById("deleteAccountDialog");
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

async function deleteAccountSubmit() {
  const passwordField = document.getElementById("deleteAccountPassword");
  const confirmField = document.getElementById("deleteAccountConfirmText");
  const errorBox = document.getElementById("deleteAccountError");
  const submitButton = document.getElementById("confirmDeleteAccountBtn");
  const password = passwordField ? passwordField.value : "";
  const confirmation = confirmField ? confirmField.value.trim().toUpperCase() : "";

  const showError = message => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  };

  if (!currentUser || !getToken()) {
    showError("Your session has expired. Please log in again.");
    return;
  }
  if (!password) {
    showError("Enter your current password to continue.");
    if (passwordField) passwordField.focus();
    return;
  }
  if (confirmation !== "DELETE") {
    showError('Type DELETE exactly in the confirmation box.');
    if (confirmField) confirmField.focus();
    return;
  }

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Deleting account…";
  }
  if (errorBox) errorBox.classList.add("hidden");

  try {
    const response = await fetch("/api/account", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders()
      },
      body: JSON.stringify({ password })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.success) {
      showError(data.error || "Account deletion failed. Please try again.");
      return;
    }

    closeDeleteAccountDialog();
    try { localStorage.removeItem(notificationStorageKey()); } catch (_) {}
    appNotifications = [];
    if (passwordField) passwordField.value = "";
    if (confirmField) confirmField.value = "";
    const loginUsername = document.getElementById("loginUsername");
    const loginPassword = document.getElementById("loginPassword");
    if (loginUsername) loginUsername.value = "";
    if (loginPassword) loginPassword.value = "";
    logout();
    showAuthMessage("Your account and associated data have been permanently deleted.", true);
  } catch (error) {
    console.error("ACCOUNT DELETE REQUEST:", error);
    showError("Could not connect to the server. Your account has not been confirmed as deleted; please try again.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Delete permanently";
    }
  }
}

/* =====================================================
   LOGOUT
===================================================== */

function logout(){

  closeCall();

  if(socket){

    socket.disconnect();

    socket=null;

  }

  localStorage.removeItem(
    "rtc_token"
  );

  localStorage.removeItem(
    "rtc_user"
  );

  currentUser=null;
  selectedUser=null;

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

}


/* =====================================================
   SCROLL
===================================================== */

function scrollMessages(){

  const box =
    document.getElementById(
      "messages"
    );

  setTimeout(
    ()=>{
      box.scrollTop =
        box.scrollHeight;
    },
    20
  );

}


/* =====================================================
   ESCAPE
===================================================== */

function escapeHtml(
  text
){

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
){

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


/* =====================================================
   AUTO LOGIN
===================================================== */

async function autoLogin(){

  const token =
    localStorage.getItem(
      "rtc_token"
    );

  const saved =
    localStorage.getItem(
      "rtc_user"
    );

  if(
    !token ||
    !saved
  )
    return;

  try{

    currentUser =
      JSON.parse(
        saved
      );

    const response =
      await fetch(
        "/api/me",
        {
          headers:
            authHeaders()
        }
      );

    if(!response.ok){

      logout();

      return;
    }

    currentUser =
      await response.json();

    localStorage.setItem(
      "rtc_user",
      JSON.stringify(
        currentUser
      )
    );

    openApp();

  }catch(error){

    console.error(
      "Auto login:",
      error
    );

    localStorage.removeItem(
      "rtc_token"
    );

    localStorage.removeItem(
      "rtc_user"
    );

    currentUser=null;

  }

}


/* =====================================================
   START
===================================================== */

window.addEventListener(
  "load",
  ()=>{
    autoLogin();
  }
);


/* =====================================================
   SERVICE WORKER
===================================================== */

if(
  "serviceWorker" in
  navigator
){

  window.addEventListener(
    "load",
    ()=>{
      navigator.serviceWorker
        .register(
          "/service-worker.js"
        )
        .catch(
          error =>
            console.error(
              "Service Worker:",
              error
            )
        );
    }
  );

}