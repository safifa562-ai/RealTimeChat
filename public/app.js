let token = localStorage.getItem("movieToken");
let currentUser = null;
let allMovies = [];

/* API */

async function api(url, options = {}) {
  options.headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (token) {
    options.headers.Authorization = "Bearer " + token;
  }

  const response = await fetch(url, options);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      error: text || "Invalid server response"
    };
  }

  if (!response.ok) {
    throw new Error(
      data.error || "Something went wrong"
    );
  }

  return data;
}


/* CREATE ACCOUNT */

async function register() {

  const username =
    document.getElementById("registerUsername").value.trim();

  const password =
    document.getElementById("registerPassword").value;

  if (!username) {
    showAuthMessage(
      "Please enter username.",
      true
    );
    return;
  }

  if (!password) {
    showAuthMessage(
      "Please enter password.",
      true
    );
    return;
  }

  if (password.length < 6) {
    showAuthMessage(
      "Password must be at least 6 characters.",
      true
    );
    return;
  }

  showAuthMessage(
    "Creating account...",
    false
  );

  try {

    const data = await api(
      "/api/register",
      {
        method: "POST",
        body: JSON.stringify({
          username: username,
          password: password
        })
      }
    );

    token = data.token;

    localStorage.setItem(
      "movieToken",
      token
    );

    currentUser = data.user;

    showAuthMessage(
      "Account created successfully!",
      false
    );

    setTimeout(function () {
      showApp();
    }, 500);

  } catch (error) {

    showAuthMessage(
      error.message ||
      "Account creation failed.",
      true
    );
  }
}


/* LOGIN */

async function login() {

  const username =
    document.getElementById("loginUsername").value.trim();

  const password =
    document.getElementById("loginPassword").value;

  if (!username || !password) {

    showAuthMessage(
      "Please enter username and password.",
      true
    );

    return;
  }

  showAuthMessage(
    "Logging in...",
    false
  );

  try {

    const data = await api(
      "/api/login",
      {
        method: "POST",
        body: JSON.stringify({
          username: username,
          password: password
        })
      }
    );

    token = data.token;

    localStorage.setItem(
      "movieToken",
      token
    );

    currentUser = data.user;

    showApp();

  } catch (error) {

    showAuthMessage(
      error.message ||
      "Login failed.",
      true
    );
  }
}


/* SESSION */

async function checkSession() {

  if (!token) {
    return;
  }

  try {

    currentUser =
      await api("/api/me");

    showApp();

  } catch (error) {

    logout();
  }
}


/* SHOW APP */

function showApp() {

  document
    .getElementById("authScreen")
    .classList.add("hidden");

  document
    .getElementById("appScreen")
    .classList.remove("hidden");

  document
    .getElementById("logoutBtn")
    .classList.remove("hidden");

  document
    .getElementById("userStatus")
    .textContent =
      currentUser.username +
      (currentUser.isPremium
        ? " ⭐ Premium"
        : "");

  if (currentUser.isAdmin) {

    document
      .getElementById("adminTab")
      .classList.remove("hidden");
  }

  loadMovies();
}


/* LOGOUT */

function logout() {

  localStorage.removeItem(
    "movieToken"
  );

  token = null;
  currentUser = null;

  location.reload();
}


/* MOVIES */

async function loadMovies() {

  try {

    allMovies =
      await api("/api/movies");

    renderMovies(allMovies);

  } catch (error) {

    document.getElementById(
      "movies"
    ).innerHTML =
      '<div class="message error">' +
      escapeHtml(error.message) +
      '</div>';
  }
}


/* RENDER MOVIES */

function renderMovies(movies) {

  const container =
    document.getElementById("movies");

  if (!movies.length) {

    container.innerHTML =
      '<div class="section">' +
      'No movies available yet.' +
      '</div>';

    return;
  }

  container.innerHTML =
    movies.map(function (movie) {

      const image =
        movie.thumbnail_url ||
        "https://via.placeholder.com/600x350?text=Movie";

      const type =
        movie.is_premium
          ? '<span class="premium">⭐ PREMIUM</span>'
          : '<span class="free">FREE</span>';

      return `
        <div class="movie">

          <img
            src="${escapeAttribute(image)}"
            alt="${escapeAttribute(movie.title)}"
          >

          <div class="movie-content">

            <h3>
              ${escapeHtml(movie.title)}
            </h3>

            <p>
              ${escapeHtml(
                movie.description || ""
              )}
            </p>

            <p>${type}</p>

            <button
              class="primary"
              onclick="watchMovie(${movie.id})"
            >
              ▶ Watch
            </button>

          </div>

        </div>
      `;

    }).join("");
}


/* WATCH */

async function watchMovie(id) {

  try {

    const movie =
      await api(
        "/api/movies/" + id + "/watch"
      );

    document
      .getElementById("player")
      .classList.remove("hidden");

    document
      .getElementById("playerTitle")
      .textContent =
      movie.title;

    const player =
      document.getElementById(
        "videoPlayer"
      );

    player.src =
      movie.videoUrl;

    player.play().catch(
      function () {}
    );

  } catch (error) {

    alert(error.message);
  }
}


/* SEARCH */

function filterMovies() {

  const query =
    document
      .getElementById("searchBox")
      .value
      .toLowerCase();

  const filtered =
    allMovies.filter(function (movie) {

      return movie.title
        .toLowerCase()
        .includes(query);

    });

  renderMovies(filtered);
}


/* ADMIN */

function showAdmin() {

  if (!currentUser ||
      !currentUser.isAdmin) {
    return;
  }

  document
    .getElementById("homeSection")
    .classList.add("hidden");

  document
    .getElementById("adminSection")
    .classList.remove("hidden");
}


function showHome() {

  document
    .getElementById("adminSection")
    .classList.add("hidden");

  document
    .getElementById("homeSection")
    .classList.remove("hidden");
}


/* ADD MOVIE */

async function addMovie() {

  const title =
    document.getElementById(
      "movieTitle"
    ).value;

  const videoUrl =
    document.getElementById(
      "movieUrl"
    ).value;

  const thumbnailUrl =
    document.getElementById(
      "thumbnailUrl"
    ).value;

  const description =
    document.getElementById(
      "movieDescription"
    ).value;

  const isPremium =
    document.getElementById(
      "moviePremium"
    ).checked;

  try {

    await api(
      "/api/admin/movies",
      {
        method: "POST",

        body: JSON.stringify({
          title: title,
          videoUrl: videoUrl,
          thumbnailUrl: thumbnailUrl,
          description: description,
          isPremium: isPremium
        })
      }
    );

    showAdminMessage(
      "Movie added successfully.",
      false
    );

    loadMovies();

  } catch (error) {

    showAdminMessage(
      error.message,
      true
    );
  }
}


/* MESSAGES */

function showAuthMessage(
  message,
  error
) {

  document.getElementById(
    "authMessage"
  ).innerHTML =
    '<div class="message ' +
    (error ? "error" : "success") +
    '">' +
    escapeHtml(message) +
    '</div>';
}


function showAdminMessage(
  message,
  error
) {

  document.getElementById(
    "adminMessage"
  ).innerHTML =
    '<div class="message ' +
    (error ? "error" : "success") +
    '">' +
    escapeHtml(message) +
    '</div>';
}


/* SECURITY */

function escapeHtml(value) {

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function escapeAttribute(value) {

  return escapeHtml(value);
}


/* START */

checkSession();
