const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

app.get('/stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

const DB_FILE = "database.json";
let db = { users: [], matches: [] };

if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)); } 
  catch (e) { console.error(e); }
} else { saveDB(); }

function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

let historyStack = [];
let botTimeout = null;

let gameState = {
  status: "SETUP",
  config: { startScore: 501, legsToWin: 3, legsInput: 3, botLevel: 0, botCheckout: 20 },
  legs: [0, 0],
  turn: 0,
  starter: 0,
  players: [],
  legDarts: [0, 0],
  timeline: [] 
};

const saveState = () => {
  historyStack.push(JSON.parse(JSON.stringify(gameState)));
  if (historyStack.length > 50) historyStack.shift();
};

io.on("connection", (socket) => {
  socket.on("init_stats_page", (userId) => {
      const stats = calculateUserStats(userId, 'all');
      socket.emit("full_stats_data", stats);
  });

  socket.on("get_stats", ({ userId, filter }) => {
      const stats = calculateUserStats(userId, filter);
      socket.emit("full_stats_data", stats);
  });
  
  socket.emit("update", gameState);
  socket.emit("users_list", db.users);

  socket.on("create_user", (name) => {
    if (!name || !name.trim()) return;
    db.users.push({ id: Date.now().toString(), name: name.trim(), created: Date.now() });
    saveDB();
    io.emit("users_list", db.users);
  });

  socket.on("delete_user", (userId) => {
      db.users = db.users.filter(u => u.id !== userId);
      saveDB();
      io.emit("users_list", db.users);
      socket.emit("delete_confirm");
  });

  socket.on("startGame", (cfg) => {
    clearTimeout(botTimeout);
    historyStack = [];
    
    let inputLegs = parseInt(cfg.legsToWin);
    let startScore = parseInt(cfg.startScore);
    if (isNaN(inputLegs) || inputLegs < 1) inputLegs = 1;
    if (isNaN(startScore) || startScore < 101) startScore = 501;
    const targetLegs = Math.ceil(inputLegs / 2);

    gameState.config = {
      startScore: startScore,
      legsInput: inputLegs,
      legsToWin: targetLegs,
      botLevel: parseInt(cfg.botLevel) || 0,
      botCheckout: parseInt(cfg.botCheckout) || 20,
    };
    gameState.legs = [0, 0];
    
    // Ustawiamy startera na podstawie wyboru z popupu
    gameState.starter = (cfg.starter !== undefined) ? cfg.starter : 0;
    
    gameState.legDarts = [0, 0]; 
    gameState.timeline = []; 

    const p1Name = getUserName(cfg.p1Id) || "GRACZ 1";
    const isBot = cfg.p2Id === "BOT";
    const p2Name = isBot ? `BOT (${gameState.config.botLevel})` : (getUserName(cfg.p2Id) || "GRACZ 2");

    gameState.players = [
      createPlayer(0, p1Name, gameState.config.startScore, false, cfg.p1Id),
      createPlayer(1, p2Name, gameState.config.startScore, isBot, isBot ? null : cfg.p2Id)
    ];

    // Ustawiamy turę na tego kto ma zacząć
    gameState.turn = gameState.starter;
    gameState.status = "PLAYING";
    
    io.emit("update", gameState);
    io.emit("voice", { type: "gameon" });
    
    // Jeśli zaczyna Bot/Rywal, checkBot to wykryje i rzuci
    checkBot();
  });

  socket.on("abort_game", () => {
      clearTimeout(botTimeout);
      gameState.status = "SETUP";
      io.emit("update", gameState);
  });

  socket.on("throw", (data) => {
    if (gameState.status !== "PLAYING") return;
    if (gameState.players[gameState.turn].isBot) return;
    
    let points = typeof data === 'object' ? parseInt(data.val) : parseInt(data);
    let doublesMissed = typeof data === 'object' ? (parseInt(data.doublesMissed) || 0) : 0;
    let finishDarts = typeof data === 'object' ? (parseInt(data.finishDarts) || 3) : 3;
    let segments = (typeof data === 'object' && data.segments) ? data.segments : null;

    handleThrow(points, doublesMissed, finishDarts, segments);
  });

  // --- POPRAWIONE UNDO ---
  socket.on("undo", () => {
      // 1. Najważniejsze: zatrzymaj bota, jeśli myśli
      if (botTimeout) {
          clearTimeout(botTimeout);
          botTimeout = null;
      }

      if (historyStack.length > 0) {
          // Cofnij ostatni ruch (to zazwyczaj ruch bota)
          gameState = historyStack.pop();

          // Jeśli gramy z botem (botLevel > 0) i po cofnięciu jest tura bota (turn === 1),
          // to znaczy, że cofnęliśmy tylko jego rzut. Cofamy raz jeszcze, żeby wrócić do Gracza.
          if (gameState.config.botLevel > 0 && gameState.turn === 1) {
              if (historyStack.length > 0) {
                  gameState = historyStack.pop();
              }
          }

          io.emit("update", gameState);

          // Jeśli mimo wszystko wypadło na bota, niech myśli od nowa
          if (gameState.players[gameState.turn].isBot) checkBot();
      }
  });
  // -----------------------

  socket.on("reset", () => {
    clearTimeout(botTimeout);
    gameState.status = "SETUP";
    io.emit("update", gameState);
  });
});

function getUserName(id) {
  const u = db.users.find(x => x.id === id);
  return u ? u.name : null;
}

function getMinDartsToFinish(score) {
    if (score > 170 || score > 110 || [99,102,103,105,106,108,109].includes(score)) return 3;
    if (score === 50 || (score <= 40 && score % 2 === 0)) return 1;
    return 2;
}

const BOGEY_NUMBERS = [169, 168, 166, 165, 163, 162, 159];

function handleThrow(points, doublesMissed, finishDarts, segments) {
  if (isNaN(points) || points < 0 || points > 180) return;

  saveState();
  const pIdx = gameState.turn;
  const player = gameState.players[pIdx];
  player.status = "";

  const scoreBefore = player.score;
  const newScore = player.score - points;
  const dartsThrownInTurn = (newScore === 0 || newScore <= 1) ? finishDarts : 3; 

  if (points > player.matchStats.highTurn) player.matchStats.highTurn = points;

  if (segments && Array.isArray(segments)) {
      segments.forEach(seg => {
          if (!player.matchStats.heatmap[seg]) player.matchStats.heatmap[seg] = 0;
          player.matchStats.heatmap[seg]++;
      });
  }

  if (gameState.legDarts[pIdx] < 9) {
      const spaceLeft = 9 - gameState.legDarts[pIdx];
      const countForF9 = Math.min(spaceLeft, dartsThrownInTurn);
      if (countForF9 > 0) {
          player.matchStats.first9Sum += points;
          player.matchStats.first9Darts += dartsThrownInTurn;
      }
  }
  gameState.legDarts[pIdx] += dartsThrownInTurn;

  if (newScore === 0) {
    let lastSeg = null;
    if (segments && Array.isArray(segments) && segments.length > 0) lastSeg = segments[segments.length - 1];
    const validCheckout = lastSeg ? (lastSeg.startsWith('D') || lastSeg === 'BULL') : true;

    if (!validCheckout) {
        player.status = "BUST";
        if (scoreBefore <= 170 && !BOGEY_NUMBERS.includes(scoreBefore)) {
             player.matchStats.doublesThrown += dartsThrownInTurn;
        }
        player.dartsThrown += dartsThrownInTurn; 
        recalcAvgs(player);
        recordTimeline(pIdx);
        io.emit("voice", { type: "bust" });
        gameState.turn = gameState.turn === 0 ? 1 : 0;
        gameState.players[gameState.turn].status = ""; 
    } else {
        player.score = 0;
        player.status = "GAME SHOT";
        const minDarts = getMinDartsToFinish(scoreBefore);
        let calculatedMisses = Math.max(0, finishDarts - minDarts);
        player.matchStats.doublesHit++;
        player.matchStats.doublesThrown += (calculatedMisses + 1);

        if (points > player.matchStats.highestCheckout) player.matchStats.highestCheckout = points;
        if (player.matchStats.bestLeg === null || gameState.legDarts[pIdx] < player.matchStats.bestLeg) {
            player.matchStats.bestLeg = gameState.legDarts[pIdx];
        }

        updateStats(player, points, finishDarts, true, calculatedMisses + 1);
        recordTimeline(pIdx);
        io.emit("voice", { type: "gameshot" });

        gameState.legs[pIdx]++;
        if (gameState.legs[pIdx] >= gameState.config.legsToWin) {
            endMatch(player);
        } else {
            gameState.starter = gameState.starter === 0 ? 1 : 0;
            setTimeout(() => {
                initLeg(gameState.config.startScore, gameState.starter);
                io.emit("update", gameState);
                checkBot();
            }, 3000);
        }
    }
  } else if (newScore <= 1) {
    player.status = "BUST";
    if (scoreBefore <= 170 && !BOGEY_NUMBERS.includes(scoreBefore)) {
         player.matchStats.doublesThrown += dartsThrownInTurn;
    }
    player.dartsThrown += dartsThrownInTurn; 
    recalcAvgs(player);
    recordTimeline(pIdx);
    io.emit("voice", { type: "bust" });
    gameState.turn = gameState.turn === 0 ? 1 : 0;
    gameState.players[gameState.turn].status = ""; 
  } else {
    player.score = newScore;
    if (doublesMissed > 0) player.matchStats.doublesThrown += doublesMissed;
    updateStats(player, points, 3, false, doublesMissed);
    recordTimeline(pIdx);
    io.emit("voice", { type: "score", val: points });
    gameState.turn = gameState.turn === 0 ? 1 : 0;
    gameState.players[gameState.turn].status = ""; 
  }

  if (gameState.status === "PLAYING") {
    io.emit("update", gameState);
    checkBot();
  }
}

function recordTimeline(playerIdx) {
    const p = gameState.players[playerIdx];
    if (!gameState.timeline) gameState.timeline = [];
    gameState.timeline.push({
        playerId: p.dbId,
        isBot: p.isBot,
        avg: parseFloat(p.avg),
        scoringAvg: parseFloat(p.scoringAvg),
        turn: gameState.timeline.length + 1
    });
}

function initLeg(score, starter) {
  gameState.legDarts = [0, 0];
  gameState.players.forEach(p => { p.score = score; p.status = ""; });
  gameState.turn = starter;
}

function endMatch(winner) {
  clearTimeout(botTimeout);
  gameState.status = "MATCH_FINISHED";
  gameState.winner = winner.name;
  const record = {
    id: Date.now(),
    date: Date.now(),
    winnerId: winner.dbId || "BOT",
    scoreStr: `${gameState.legs[0]} : ${gameState.legs[1]}`,
    timeline: gameState.timeline,
    players: gameState.players.map(p => ({
      dbId: p.dbId, name: p.name, stats: p.matchStats, avg: p.avg, scoringAvg: p.scoringAvg, first9Avg: p.first9Avg, dartsThrown: p.dartsThrown
    }))
  };
  db.matches.push(record);
  saveDB();
  io.emit("update", gameState);
}

function checkBot() {
  clearTimeout(botTimeout);
  if (gameState.status !== "PLAYING") return;
  const p = gameState.players[gameState.turn];
  if (p.isBot) {
    botTimeout = setTimeout(() => {
        const avg = gameState.config.botLevel;
        const checkoutChance = gameState.config.botCheckout;
        let score = generateBotScore(avg, p.score);
        let finish = 3, miss = 0;

        if (p.score - score === 0) {
            const roll = Math.random() * 100;
            if (roll <= checkoutChance) {
                finish = Math.ceil(Math.random() * 3);
                miss = finish - 1; 
            } else {
                let missedScore = score;
                if (score % 2 === 0 && score <= 40) missedScore = score / 2;
                else missedScore = Math.max(0, score - 10);
                if (p.score - missedScore <= 1) missedScore = Math.max(0, p.score - 2); 
                score = missedScore;
                finish = 3;
                miss = 3;
            }
        } 
        else if (p.score <= 50 && score > 0) {
            if (Math.random() > 0.5) miss = 1;
        }

        handleThrow(score, miss, finish, null);
    }, 3000 + Math.random() * 1500); 
  }
}

function generateBotScore(avg, current) {
    if (current <= 40) return Math.random() < avg/120 ? current : (Math.random()>0.6 ? current-1 : 0);
    let s = Math.floor(avg + (Math.random() * 40 - 20));
    return Math.max(0, Math.min(180, (current - s <= 1) ? current - 40 : s));
}

function createPlayer(id, name, score, isBot, dbId) {
    return {
        id, name, score, isBot, dbId,
        dartsThrown: 0, totalScore: 0, avg: "0.00", scoringAvg: "0.00", first9Avg: "0.00", status: "",
        matchStats: {
            score0:0, score20:0, score40:0, score60:0, score80:0, score100:0, score120:0, score140:0, score180:0,
            doublesThrown:0, doublesHit:0, checkoutPercent:"0%", first9Sum:0, first9Darts:0, scoringSum:0, scoringDarts:0,
            bestLeg:null, highestCheckout:0, highTurn:0,
            heatmap: {} 
        }
    };
}

function updateStats(p, points, darts, checkout, doublesMissed) {
  p.totalScore += points;
  p.dartsThrown += darts;
  if (!checkout && doublesMissed === 0) { p.matchStats.scoringSum += points; p.matchStats.scoringDarts += darts; }
  
  if (points === 180) p.matchStats.score180++;
  else if (points >= 140) p.matchStats.score140++;
  else if (points >= 120) p.matchStats.score120++;
  else if (points >= 100) p.matchStats.score100++;
  else if (points >= 80) p.matchStats.score80++;
  else if (points >= 60) p.matchStats.score60++;
  else if (points >= 40) p.matchStats.score40++;
  else if (points >= 20) p.matchStats.score20++;
  else p.matchStats.score0++;
  
  recalcAvgs(p);
}

function recalcAvgs(p) {
    if (p.dartsThrown > 0) p.avg = ((p.totalScore / p.dartsThrown) * 3).toFixed(2);
    if (p.matchStats.first9Darts > 0) p.first9Avg = ((p.matchStats.first9Sum / p.matchStats.first9Darts) * 3).toFixed(2);
    if (p.matchStats.scoringDarts > 0) p.scoringAvg = ((p.matchStats.scoringSum / p.matchStats.scoringDarts) * 3).toFixed(2);
    else p.scoringAvg = p.avg;
    if (p.matchStats.doublesThrown > 0) p.matchStats.checkoutPercent = ((p.matchStats.doublesHit / p.matchStats.doublesThrown) * 100).toFixed(1) + "%";
}

function calculateUserStats(userId, filter = 'all') {
  let matches = db.matches.filter(m => m.players.some(p => p.dbId === userId));
  matches.sort((a, b) => b.date - a.date);

  if (filter !== 'all' && filter !== 'today' && filter !== 'week' && filter !== 'month') {
      const singleMatch = matches.find(m => m.id == filter);
      if (singleMatch) return generateSingleMatchStats(userId, singleMatch, matches);
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (filter === 'today') matches = matches.filter(m => m.date >= startOfDay);
  else if (filter === 'week') matches = matches.filter(m => m.date >= startOfDay - (7*86400000));
  else if (filter === 'month') matches = matches.filter(m => m.date >= startOfDay - (30*86400000));

  matches.sort((a, b) => b.date - a.date);

  let totalDarts=0, totalScore=0, f9Sum=0, f9Count=0, dHit=0, dThrown=0, games=0, wins=0;
  let s0=0,s20=0,s40=0,s60=0,s80=0,s100=0,s120=0,s140=0,s180=0;
  let bestLeg=null, hiOut=0, hiTurn=0;
  let aggregatedHeatmap = {};
  let trendLabels=[], trendAvg=[], trendScoring=[];
  
  const chartMatches = matches.slice(0, 30).reverse();
  chartMatches.forEach(m => {
      const p = m.players.find(x => x.dbId === userId);
      if(!p) return;
      trendLabels.push(new Date(m.date).toLocaleDateString(undefined, {month:'numeric', day:'numeric'}));
      trendAvg.push(parseFloat(p.avg));
      trendScoring.push(parseFloat(p.scoringAvg || p.avg));
  });

  matches.forEach(m => {
      const p = m.players.find(x => x.dbId === userId);
      if(!p) return;
      games++; if(m.winnerId === userId) wins++;
      totalDarts+=p.dartsThrown; totalScore+=(parseFloat(p.avg)/3)*p.dartsThrown;
      f9Sum+=parseFloat(p.first9Avg||p.avg); f9Count++;
      s0+=p.stats.score0||0; s20+=p.stats.score20||0; s40+=p.stats.score40||0;
      s60+=p.stats.score60||0; s80+=p.stats.score80||0; s100+=p.stats.score100;
      s120+=p.stats.score120||0; s140+=p.stats.score140; s180+=p.stats.score180;
      dHit+=p.stats.doublesHit; dThrown+=p.stats.doublesThrown;
      if(p.stats.highestCheckout > hiOut) hiOut = p.stats.highestCheckout;
      if(p.stats.highTurn > hiTurn) hiTurn = p.stats.highTurn;
      if(p.stats.bestLeg !== null && (bestLeg === null || p.stats.bestLeg < bestLeg)) bestLeg = p.stats.bestLeg;
      if(p.stats.heatmap) for(const [seg, count] of Object.entries(p.stats.heatmap)) {
          if(!aggregatedHeatmap[seg]) aggregatedHeatmap[seg] = 0;
          aggregatedHeatmap[seg] += count;
      }
  });

  const avg = totalDarts>0 ? ((totalScore/totalDarts)*3).toFixed(2) : "0.00";
  const first9 = f9Count>0 ? (f9Sum/f9Count).toFixed(2) : "0.00";
  const coPct = dThrown>0 ? ((dHit/dThrown)*100).toFixed(1) : "0.0";
  const winRate = games>0 ? ((wins/games)*100).toFixed(0) : "0";

  return {
    user: getUserName(userId),
    isSingleMatch: false,
    summary: { avg, first9, coPct, winRate, games, wins, bestLeg: bestLeg||"-", hiOut, hiTurn },
    distribution: [s0, s20, s40, s60, s80, s100, s120, s140, s180],
    charts: { labels: trendLabels, avg: trendAvg, scoring: trendScoring, title: "FORMA (AVG)" },
    heatmap: aggregatedHeatmap,
    history: matches.map(m => ({
        id: m.id, date: m.date, result: m.winnerId===userId?"W":"L", score: m.scoreStr,
        rival: m.players.find(x => x.dbId !== userId)?.name || "Unknown",
        avg: m.players.find(x => x.dbId === userId)?.avg
    }))
  };
}

function generateSingleMatchStats(userId, m, allMatches) {
    const p = m.players.find(x => x.dbId === userId);
    const opponent = m.players.find(x => x.dbId !== userId);
    const opponentAvg = opponent ? opponent.avg : "-";
    const opponentScoring = opponent ? (opponent.scoringAvg || opponent.avg) : "-";

    let trendLabels=[], trendAvg=[], trendScoring=[];
    let trendOppAvg=[], trendOppScoring=[];

    if (m.timeline) {
        const userTimeline = m.timeline.filter(t => t.playerId === userId);
        const opponentTimeline = m.timeline.filter(t => t.playerId !== userId);

        userTimeline.forEach((t, i) => {
            trendLabels.push("T" + (i+1));
            trendAvg.push(t.avg);
            trendScoring.push(t.scoringAvg);

            if (opponentTimeline[i]) {
                trendOppAvg.push(opponentTimeline[i].avg);
                trendOppScoring.push(opponentTimeline[i].scoringAvg);
            } else {
                trendOppAvg.push(null);
                trendOppScoring.push(null);
            }
        });
    }

    const pct = p.stats.doublesThrown > 0 ? ((p.stats.doublesHit / p.stats.doublesThrown) * 100).toFixed(1) : "0.0";
    const coDisplay = `${p.stats.doublesHit}/${p.stats.doublesThrown} (${pct}%)`;

    return {
        user: getUserName(userId),
        isSingleMatch: true, 
        summary: { 
            avg: p.avg, 
            scoringAvg: p.scoringAvg, 
            opponentAvg: opponentAvg, 
            opponentScoring: opponentScoring, 
            first9: p.first9Avg || "-", 
            coPct: coDisplay, 
            winRate: "N/A", 
            games: "N/A", wins: "N/A", 
            bestLeg: p.stats.bestLeg || "-", 
            hiOut: p.stats.highestCheckout, 
            hiTurn: p.stats.highTurn,
            total180: p.stats.score180,
            total140: p.stats.score140,
            total100: p.stats.score100,
            dartsThrown: p.dartsThrown,
            matchResult: m.winnerId === userId ? "ZWYCIĘSTWO" : "PORAŻKA"
        },
        distribution: [
            p.stats.score0||0, p.stats.score20||0, p.stats.score40||0, 
            p.stats.score60||0, p.stats.score80||0, p.stats.score100, 
            p.stats.score120||0, p.stats.score140, p.stats.score180
        ],
        charts: { 
            labels: trendLabels, 
            avg: trendAvg, 
            scoring: trendScoring, 
            oppAvg: trendOppAvg,
            oppScoring: trendOppScoring,
            title: "PRZEBIEG MECZU (TY vs RYWAL)"
        },
        heatmap: p.stats.heatmap || {},
        history: allMatches.map(mm => ({
            id: mm.id, date: mm.date, result: mm.winnerId===userId?"W":"L", score: mm.scoreStr,
            rival: mm.players.find(x => x.dbId !== userId)?.name || "Unknown",
            avg: mm.players.find(x => x.dbId === userId)?.avg
        }))
    };
}

// --- PORT 3100 Z ŁADNYM OZNACZENIEM W KONSOLI ---
const PORT = 3100;
server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("###################################################");
    console.log(`##  SUKCES! SERWER DZIALA NA PORCIE ${PORT}       ##`);
    console.log("##  Nie zamykaj tego okna podczas gry.           ##");
    console.log("###################################################");
    console.log("");
});