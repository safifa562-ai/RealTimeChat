let movies = JSON.parse(localStorage.getItem("movies") || "[]");

// Logout
function logout() {
  localStorage.removeItem("token");
  window.location.href = "/";
}

// Add movie
function addMovie() {
  const title = document.getElementById("movieTitle").value.trim();
  const url = document.getElementById("movieUrl").value.trim();
  const message = document.getElementById("message");

  if (!title || !url) {
    message.textContent = "Please enter movie title and video URL";
    return;
  }

  const movie = {
    id: Date.now(),
    title: title,
    url: url
  };

  movies.push(movie);
  localStorage.setItem("movies", JSON.stringify(movies));

  document.getElementById("movieTitle").value = "";
  document.getElementById("movieUrl").value = "";

  message.textContent = "Movie added successfully 🎬";

  showMovies();
}

// Show movies
function showMovies() {
  const list = document.getElementById("movieList");

  if (!list) return;

  list.innerHTML = "";

  if (movies.length === 0) {
    list.innerHTML = `
      <div class="movie-card">
        <p>No movies available yet.</p>
      </div>
    `;
    return;
  }

  movies.forEach(movie => {
    const card = document.createElement("div");
    card.className = "movie-card";

    card.innerHTML = `
      <h3>🎬 ${escapeHTML(movie.title)}</h3>

      <video controls playsinline preload="metadata">
        <source src="${escapeAttribute(movie.url)}" type="video/mp4">
        Your browser does not support video playback.
      </video>

      <button onclick="deleteMovie(${movie.id})">
        🗑️ Delete
      </button>
    `;

    list.appendChild(card);
  });
}

// Delete movie
function deleteMovie(id) {
  movies = movies.filter(movie => movie.id !== id);

  localStorage.setItem("movies", JSON.stringify(movies));

  showMovies();
}

// Basic HTML protection
function escapeHTML(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttribute(text) {
  return text.replace(/"/g, "&quot;");
}

// Load movies
document.addEventListener("DOMContentLoaded", () => {
  showMovies();
});
