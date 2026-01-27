const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let historyStack = [];
let gameState = {
  status: "SETUP",
  config: { startScore: 501, legsToWin: 3, botLevel: 0 },
  legs: [0, 0],
  turn: 0,
  starter: 0,
  players: [],
};

const saveState = () => {
  historyStack.push(JSON.parse(JSON.stringify(gameState)));
  if (historyStack.length > 50) historyStack.shift();
};

io.on("connection", (socket) => {
  socket.emit("update", gameState);

  socket.on("startGame", (cfg) => {
    historyStack = [];
    // Zabezpieczenie danych wejściowych
    gameState.config = {
      startScore: parseInt(cfg.startScore) || 501,
      legsToWin: parseInt(cfg.legsToWin) || 3,
      botLevel: parseInt(cfg.botLevel) || 0,
    };
    gameState.legs = [0, 0];
    gameState.starter = 0;

    initLeg(gameState.config.startScore, 0);
    gameState.status = "PLAYING";
    io.emit("update", gameState);
    checkBot();
  });

  socket.on("throw", (val) => {
    if (gameState.status !== "PLAYING") return;
    if (gameState.players[gameState.turn].isBot) return;
    handleThrow(parseInt(val));
  });

  socket.on("undo", () => {
    if (historyStack.length > 0) {
      gameState = historyStack.pop();
      io.emit("update", gameState);
    }
  });

  socket.on("reset", () => {
    gameState.status = "SETUP";
    io.emit("update", gameState);
  });
});

function handleThrow(points) {
  if (isNaN(points) || points < 0 || points > 180) return;

  saveState();
  const pIdx = gameState.turn;
  const player = gameState.players[pIdx];
  const newScore = player.score - points;

  gameState.players.forEach((p) => (p.status = ""));

  if (newScore === 0) {
    // GAME SHOT
    player.score = 0;
    updateStats(player, points);
    player.status = "GAME SHOT";
    io.emit("voice", { type: "gameshot" });

    gameState.legs[pIdx]++;

    if (gameState.legs[pIdx] >= gameState.config.legsToWin) {
      gameState.status = "MATCH_FINISHED";
      gameState.winner = player.name;
    } else {
      gameState.starter = gameState.starter === 0 ? 1 : 0;
      setTimeout(() => {
        initLeg(gameState.config.startScore, gameState.starter);
        io.emit("update", gameState);
        checkBot();
      }, 4000);
    }
  } else if (newScore <= 1) {
    // BUST
    player.status = "BUST";
    player.dartsThrown += 3;
    updateStatsAvgOnly(player);
    io.emit("voice", { type: "bust" });
    gameState.turn = gameState.turn === 0 ? 1 : 0;
  } else {
    // SCORE
    player.score = newScore;
    updateStats(player, points);
    io.emit("voice", { type: "score", val: points }); // Czytamy wszystko
    gameState.turn = gameState.turn === 0 ? 1 : 0;
  }

  io.emit("update", gameState);
  checkBot();
}

function checkBot() {
  if (gameState.status !== "PLAYING") return;
  const player = gameState.players[gameState.turn];
  if (player.isBot) {
    setTimeout(
      () => {
        const botAvg = gameState.config.botLevel;
        let score = generateBotScore(botAvg, player.score);
        handleThrow(score);
      },
      1500 + Math.random() * 500,
    );
  }
}

function generateBotScore(avg, current) {
  if (current <= 40) {
    if (Math.random() < avg / 150) return current;
    if (Math.random() > 0.6) return current - 1;
    return Math.floor(Math.random() * (current - 2));
  }
  let variance = 25 - avg / 5;
  let score = Math.floor(avg + Math.random() * variance * 2 - variance);
  if (score > 180) score = 180;
  if (score < 0) score = 0;
  if (current - score <= 1) score = Math.max(0, current - 40);
  return score;
}

function initLeg(score, starter) {
  const isBot = gameState.config.botLevel > 0;
  if (
    gameState.players.length === 0 ||
    (gameState.legs[0] === 0 && gameState.legs[1] === 0)
  ) {
    gameState.players = [
      {
        id: 0,
        name: "TY",
        score: score,
        totalScore: 0,
        dartsThrown: 0,
        avg: "0.00",
        lastScore: "-",
        status: "",
        isBot: false,
      },
      {
        id: 1,
        name: isBot ? `BOT (${gameState.config.botLevel})` : "RIVAL",
        score: score,
        totalScore: 0,
        dartsThrown: 0,
        avg: "0.00",
        lastScore: "-",
        status: "",
        isBot: isBot,
      },
    ];
  } else {
    gameState.players.forEach((p) => {
      p.score = score;
      p.status = "";
      p.lastScore = "-";
    });
  }
  gameState.turn = starter;
}

function updateStats(p, points) {
  p.lastScore = points;
  p.totalScore += points;
  p.dartsThrown += 3;
  p.avg = ((p.totalScore / p.dartsThrown) * 3).toFixed(2);
}

function updateStatsAvgOnly(p) {
  p.avg = ((p.totalScore / p.dartsThrown) * 3).toFixed(2);
}

server.listen(3100, "0.0.0.0", () =>
  console.log("Dart Server Full Config na 3100"),
);
