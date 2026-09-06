let score = 0;
let time = 30;
let combo = 0;

let level = 1;

let playing = false;

let timer = null;

let soundOn = true;


// ==========================
// SAVED DATA
// ==========================

let coins =
  Number(localStorage.getItem("tapRushCoins")) || 0;

let best =
  Number(localStorage.getItem("tapRushBest")) || 0;

let totalTaps =
  Number(localStorage.getItem("tapRushTotalTaps")) || 0;


// ==========================
// ELEMENTS
// ==========================

const scoreElement =
  document.getElementById("score");

const timeElement =
  document.getElementById("time");

const comboElement =
  document.getElementById("combo");

const coinsElement =
  document.getElementById("coins");

const bestElement =
  document.getElementById("best");

const levelElement =
  document.getElementById("level");

const messageElement =
  document.getElementById("message");

const tapButton =
  document.getElementById("tapButton");

const startButton =
  document.getElementById("startButton");

const progressBar =
  document.getElementById("progressBar");

const progressText =
  document.getElementById("progressText");

const recordScore =
  document.getElementById("recordScore");

const totalTapsElement =
  document.getElementById("totalTaps");

const totalCoinsElement =
  document.getElementById("totalCoins");


// ==========================
// INITIAL DISPLAY
// ==========================

updateDisplay();


// ==========================
// START GAME
// ==========================

function startGame() {

  if (playing) return;

  score = 0;
  time = 30;
  combo = 0;

  playing = true;

  scoreElement.textContent = score;
  timeElement.textContent = time;
  comboElement.textContent = combo;

  messageElement.textContent = "🔥 GO!";

  tapButton.classList.add("running");

  startButton.textContent = "GAME RUNNING...";

  clearInterval(timer);

  timer = setInterval(() => {

    time--;

    timeElement.textContent = time;

    if (time <= 0) {
      endGame();
    }

  }, 1000);
}


// ==========================
// TAP
// ==========================

function tap() {

  if (!playing) return;


  score++;

  combo++;

  coins++;

  totalTaps++;


  // Combo bonus

  if (combo % 10 === 0) {

    score += 5;

    coins += 5;

    messageElement.textContent =
      "🔥 COMBO BONUS +5!";
  }


  // Level system

  level =
    Math.floor(score / 50) + 1;


  // Update screen

  scoreElement.textContent = score;

  comboElement.textContent = combo;

  coinsElement.textContent = coins;

  levelElement.textContent = level;


  updateProgress();

  updateAchievements();

  saveData();

  playTapSound();
}


// ==========================
// END GAME
// ==========================

function endGame() {

  playing = false;

  clearInterval(timer);

  tapButton.classList.remove("running");

  startButton.textContent = "▶ PLAY AGAIN";


  if (score > best) {

    best = score;

    messageElement.textContent =
      "🏆 NEW HIGH SCORE: " + score;

  } else {

    messageElement.textContent =
      "Game Over! Score: " + score;
  }


  saveData();

  updateDisplay();

  playEndSound();
}


// ==========================
// PROGRESS
// ==========================

function updateProgress() {

  const current =
    score % 50;

  const percent =
    (current / 50) * 100;


  progressBar.style.width =
    percent + "%";


  if (score < 50) {

    progressText.textContent =
      score + " / 50";

  } else {

    progressText.textContent =
      current + " / 50";
  }
}


// ==========================
// ACHIEVEMENTS
// ==========================

function updateAchievements() {

  const a10 =
    document.getElementById("a10");

  const a50 =
    document.getElementById("a50");

  const a100 =
    document.getElementById("a100");


  if (score >= 10) {

    a10.classList.add("unlocked");

  }


  if (score >= 50) {

    a50.classList.add("unlocked");

  }


  if (score >= 100) {

    a100.classList.add("unlocked");

  }
}


// ==========================
// UPDATE DISPLAY
// ==========================

function updateDisplay() {

  coinsElement.textContent = coins;

  bestElement.textContent = best;

  levelElement.textContent =
    Math.floor(best / 50) + 1;

  recordScore.textContent = best;

  totalTapsElement.textContent =
    totalTaps;

  totalCoinsElement.textContent =
    coins;

  updateProgress();

  updateAchievements();
}


// ==========================
// SAVE
// ==========================

function saveData() {

  localStorage.setItem(
    "tapRushCoins",
    coins
  );

  localStorage.setItem(
    "tapRushBest",
    best
  );

  localStorage.setItem(
    "tapRushTotalTaps",
    totalTaps
  );
}


// ==========================
// SOUND
// ==========================

function toggleSound() {

  soundOn = !soundOn;

  const button =
    document.getElementById("soundBtn");

  button.textContent =
    soundOn ? "🔊" : "🔇";
}


function playTapSound() {

  if (!soundOn) return;

  try {

    const audio =
      new Audio();

    audio.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

    audio.volume = 0.05;

    audio.play().catch(() => {});

  } catch (error) {}

}


function playEndSound() {

  if (!soundOn) return;

}


// ==========================
// RESET
// ==========================

function resetGame() {

  const confirmReset =
    confirm(
      "Are you sure you want to reset your game data?"
    );

  if (!confirmReset) return;


  clearInterval(timer);

  score = 0;

  time = 30;

  combo = 0;

  level = 1;

  coins = 0;

  best = 0;

  totalTaps = 0;

  playing = false;


  localStorage.removeItem(
    "tapRushCoins"
  );

  localStorage.removeItem(
    "tapRushBest"
  );

  localStorage.removeItem(
    "tapRushTotalTaps"
  );


  tapButton.classList.remove("running");

  startButton.textContent =
    "▶ START GAME";

  messageElement.textContent =
    "Press START GAME";


  scoreElement.textContent = 0;

  timeElement.textContent = 30;

  comboElement.textContent = 0;


  updateDisplay();
}
