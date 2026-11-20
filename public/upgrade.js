/* Additive UX enhancements for RealTimeChat / VibeCircle.
   This file does not change authentication, messages, or database records. */
(function () {
  "use strict";

  function initConnectionStatus() {
    if (document.getElementById("rtcConnectionBanner")) return;

    const banner = document.createElement("div");
    banner.id = "rtcConnectionBanner";
    banner.className = "rtc-connection-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.hidden = true;
    document.body.prepend(banner);

    let restoreTimer = null;
    function showOffline() {
      window.clearTimeout(restoreTimer);
      banner.textContent = "You are offline. Your saved app shell is available; live chats will reconnect when internet returns.";
      banner.dataset.state = "offline";
      banner.hidden = false;
    }
    function showOnline() {
      window.clearTimeout(restoreTimer);
      banner.textContent = "Connection restored. Reconnecting to live services…";
      banner.dataset.state = "online";
      banner.hidden = false;
      restoreTimer = window.setTimeout(function () {
        banner.hidden = true;
      }, 3600);
    }

    window.addEventListener("offline", showOffline);
    window.addEventListener("online", showOnline);
    if (!navigator.onLine) showOffline();
  }

  function initInstallPrompt() {
    let installPrompt = null;
    const host = document.querySelector(".sidebarTopActions");
    if (!host || document.getElementById("rtcInstallButton")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "rtcInstallButton";
    button.className = "iconAction rtc-install-button";
    button.textContent = "＋";
    button.title = "Install app";
    button.setAttribute("aria-label", "Install RealTimeChat");
    button.hidden = true;
    host.appendChild(button);

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPrompt = event;
      button.hidden = false;
    });

    window.addEventListener("appinstalled", function () {
      installPrompt = null;
      button.hidden = true;
      button.title = "App installed";
    });

    button.addEventListener("click", async function () {
      if (!installPrompt) return;
      button.disabled = true;
      try {
        installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice && choice.outcome === "accepted") button.hidden = true;
        installPrompt = null;
      } catch (error) {
        console.warn("Install prompt:", error);
      } finally {
        button.disabled = false;
      }
    });
  }

  function initSearchShortcut() {
    function focusSearch() {
      const input = document.getElementById("searchInput");
      if (!input) return;
      input.focus();
      if (typeof input.select === "function") input.select();
    }

    document.addEventListener("keydown", function (event) {
      const target = event.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || (target && target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (event.key === "/" && !typing && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        focusSearch();
      }
    });
  }

  function init() {
    initConnectionStatus();
    initInstallPrompt();
    initSearchShortcut();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
