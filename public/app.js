let token = localStorage.getItem("movieToken");
let currentUser = null;


// --------------------
// API
// --------------------

async function api(url, options = {}) {

  options.headers = {
    ...(options.headers || {})
  };

  if (token) {
    options.headers.Authorization =
      "Bearer " + token;
  }

  const response = await fetch(url, options);

  const data = await response.json();

  if (response.status === 401) {
    logout();
    return null;
  }

  return data;
}


// --------------------
// Start
// --------------------

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    if (!token) {
      showAuth();
      return;
    }

    const data = await api("/api/me");

    if (!data || !data.user) {
      logout();
      return;
    }

    currentUser = data.user;

    showApp();

    loadMovies();
  }
);


// --------------------
// Auth UI
// --------------------

function showAuth() {

  document
    .getElementById("authScreen")
    .classList.remove("hidden");

  document
    .getElementById("app")
    .classList.add("hidden");
}


function showApp() {

  document
    .getElementById("authScreen")
    .classList.add("hidden");

  document
    .getElementById("app")
    .classList.remove("hidden");
}


function showLogin() {

  document
    .getElementById("loginBox")
    .classList.remove("hidden");

  document
    .getElementById("signupBox")
    .classList.add("hidden");

  document
    .getElementById("authMessage")
    .textContent = "";
}


function showSignup() {

  document
    .getElementById("loginBox")
    .classList.add("hidden");

  document
    .getElementById("signupBox")
    .classList.remove("hidden");

  document
    .getElementById("authMessage")
    .textContent = "";
}


// --------------------
// Signup
// --------------------

async function signup() {

  const username =
    document
      .getElementById("signupUsername")
      .value
      .trim();

  const password =
    document
      .getElementById("signupPassword")
      .value;

  if (!username || !password) {
    showAuthMessage(
      "Enter username and password"
    );
    return;
  }

  try {

    const response = await fetch(
      "/api/signup",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          username,
          password
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      showAuthMessage(data.message);
      return;
    }

    token = data.token;

    localStorage.setItem(
      "movieToken",
      token
    );

    currentUser = data.user;

    showApp();

    loadMovies();

  } catch (error) {

    showAuthMessage(
      "Server connection error"
    );
  }
}


// --------------------
// Login
// --------------------

async function login() {

  const username =
    document
      .getElementById("loginUsername")
      .value
      .trim();

  const password =
    document
      .getElementById("loginPassword")
      .value;

  if (!username || !password) {
    showAuthMessage(
      "Enter username and password"
    );
    return;
  }

  try {

    const response = await fetch(
      "/api/login",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          username,
          password
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      showAuthMessage(data.message);
      return;
    }

    token = data.token;

    localStorage.setItem(
      "movieToken",
      token
    );

    currentUser = data.user;

    showApp();

    loadMovies();

  } catch (error) {

    showAuthMessage(
      "Server connection error"
    );
  }
}


function showAuthMessage(message) {

  document
    .getElementById("authMessage")
    .textContent = message;
}


// --------------------
// Logout
// --------------------

function logout() {

  localStorage.removeItem(
    "movieToken"
  );

  token = null;
  currentUser = null;

  location.reload();
}


// --------------------
// Pages
// --------------------

function showHome() {

  document
    .getElementById("homePage")
    .classList.remove("hidden");

  document
    .getElementById("watchPage")
    .classList.add("hidden");

  document
    .getElementById("adminPage")
    .classList.add("hidden");

  const player =
    document.getElementById(
      "videoPlayer"
    );

  player.pause();
}


function showAdmin() {

  document
    .getElementById("homePage")
    .classList.add("hidden");

  document
    .getElementById("watchPage")
    .classList.add("hidden");

  document
    .getElementById("adminPage")
    .classList.remove("hidden");
}


// --------------------
// Movies
// --------------------

async function loadMovies() {

  const search =
    document
      .getElementById("searchInput")
      .value
      .trim();

  const data =
    await fetch(
      "/api/movies?search=" +
      encodeURIComponent(search)
    ).then(res => res.json());

  const list =
    document.getElementById(
      "movieList"
    );

  list.innerHTML = "";

  if (!data || data.length === 0) {

    list.innerHTML = `
      <div class="notice">
        No movies found.
      </div>
    `;

    return;
  }

  data.forEach(movie => {

    const card =
      document.createElement("div");

    card.className =
      "movie-card";

    card.innerHTML = `

      <video
        src="${movie.video_url}"
        muted
        preload="metadata"
      ></video>

      <div class="movie-info">

        <h3>
          ${escapeHtml(movie.title)}
        </h3>

        <p>
          ${escapeHtml(
            movie.description || ""
          )}
        </p>

        <button
          class="watch-button"
          onclick="watchMovie(
            ${movie.id},
            '${encodeURIComponent(movie.title)}',
            '${encodeURIComponent(
              movie.description || ""
            )}',
            '${movie.video_url}'
          )"
        >
          ▶ Watch
        </button>

      </div>
    `;

    list.appendChild(card);
  });
}


// --------------------
// Watch
// --------------------

function watchMovie(
  id,
  title,
  description,
  videoUrl
) {

  document
    .getElementById("homePage")
    .classList.add("hidden");

  document
    .getElementById("adminPage")
    .classList.add("hidden");

  document
    .getElementById("watchPage")
    .classList.remove("hidden");

  document
    .getElementById("watchTitle")
    .textContent =
    decodeURIComponent(title);

  document
    .getElementById("watchDescription")
    .textContent =
    decodeURIComponent(description);

  const player =
    document.getElementById(
      "videoPlayer"
    );

  player.src = videoUrl;

  player.load();

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}


// --------------------
// Upload
// --------------------

async function uploadMovie(event) {

  event.preventDefault();

  const title =
    document
      .getElementById("movieTitle")
      .value
      .trim();

  const description =
    document
      .getElementById("movieDescription")
      .value
      .trim();

  const video =
    document
      .getElementById("movieVideo")
      .files[0];

  const message =
    document.getElementById(
      "uploadMessage"
    );

  if (!video) {

    message.textContent =
      "Select a video first.";

    return;
  }

  const formData =
    new FormData();

  formData.append(
    "title",
    title
  );

  formData.append(
    "description",
    description
  );

  formData.append(
    "video",
    video
  );

  message.textContent =
    "Uploading... Please wait.";

  try {

    const response =
      await fetch(
        "/api/movies",
        {
          method: "POST",

          headers: {
            Authorization:
              "Bearer " + token
          },

          body: formData
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      message.textContent =
        data.message;

      return;
    }

    message.textContent =
      "Movie uploaded successfully!";

    document
      .getElementById(
        "uploadForm"
      )
      .reset();

    loadMovies();

  } catch (error) {

    message.textContent =
      "Upload failed.";
  }
}


// --------------------
// Security helper
// --------------------

function escapeHtml(text) {

  const div =
    document.createElement("div");

  div.textContent = text;

  return div.innerHTML;
}
