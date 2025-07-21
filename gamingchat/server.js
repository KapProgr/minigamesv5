const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = {}; 
const activeInvites = {};
const gameRooms = {};

io.on('connection', (socket) => {
    socket.on('join', (username) => {
        if (Object.values(users).includes(username)) {
            socket.emit('joinFailed', `Username "${username}" is already taken.`);
            return;
        }
        users[socket.id] = username;
        const usersList = Object.keys(users).map(id => ({ id, username: users[id] }));
        socket.emit('joinSuccess', { id: socket.id, username, users: usersList });
        socket.broadcast.emit('userJoined', { username, users: usersList });
    });

    socket.on('message', (message) => {
        const username = users[socket.id] || 'Anonymous';
        io.emit('message', { username, message });
    });

    socket.on('inviteGame', ({ opponentId, game }) => {
        if (!users[opponentId] || opponentId === socket.id) return;
        const inviteId = `${socket.id}-${opponentId}-${Date.now()}`;
        activeInvites[inviteId] = { inviterId: socket.id, opponentId, game };
        io.to(opponentId).emit('gameInvite', { id: inviteId, from: users[socket.id], game });
    });

    socket.on('acceptInvite', (inviteId) => {
        const invite = activeInvites[inviteId];
        if (!invite || invite.opponentId !== socket.id) return;
        const { inviterId, opponentId, game } = invite;
        const gameId = `game-${game}-${Date.now()}`;
        const playerNames = { [inviterId]: users[inviterId], [opponentId]: users[opponentId] };
        let gameState;

        switch (game) {
            case 'tic-tac-toe':
                gameState = { board: Array(9).fill(null), currentPlayer: inviterId, players: { [inviterId]: 'X', [opponentId]: 'O' }, playerNames, turnCount: 0, winner: null };
                break;
            case 'rock-paper-scissors':
                gameState = { players: { [inviterId]: { move: null, score: 0 }, [opponentId]: { move: null, score: 0 } }, playerNames };
                break;
            case 'number-guess':
                gameState = { setter: inviterId, guesser: opponentId, playerNames, targetNumber: null, attempts: 0, maxAttempts: 7, feedback: `Waiting for ${playerNames[inviterId]} to set a number.` };
                break;
            case 'snake':
                const GRID_SIZE = 25;
                gameState = { gridSize: GRID_SIZE, players: { [inviterId]: { snake: [{ x: 5, y: 5 }], dir: 'right', alive: true }, [opponentId]: { snake: [{ x: 19, y: 19 }], dir: 'left', alive: true } }, food: { x: 12, y: 12 }, playerNames };
                break;
            case 'air-hockey':
                const width = 400, height = 600;
                gameState = { width, height, puck: { x: width/2, y: height/2, vx: 0, vy: 0, r: 15 }, paddles: { [inviterId]: { x: width/2, y: height - 50, r: 25 }, [opponentId]: { x: width/2, y: 50, r: 25 } }, scores: { [inviterId]: 0, [opponentId]: 0 }, playerNames };
                break;
            case 'palermo':
                gameState = { playerInfo: { [inviterId]: { username: playerNames[inviterId], role: 'Killer', alive: true }, [opponentId]: { username: playerNames[opponentId], role: 'Citizen', alive: true } }, alivePlayerIds: [inviterId, opponentId], phase: 'day', votes: {}, message: `Day 1. Discuss and vote.` };
                break;
            case 'memory-game':
                const emojis = ['😀', '😂', '😍', '🥳', '😎', '🤩', '👍', '❤️'];
                const board = [...emojis, ...emojis].sort(() => 0.5 - Math.random()).map(emoji => ({ emoji, flipped: false, matched: false }));
                gameState = { board, players: [inviterId, opponentId], playerNames, currentPlayer: inviterId, flippedIndices: [], scores: { [inviterId]: 0, [opponentId]: 0 }, lockBoard: false, matchedPairs: 0 };
                break;
        }

        if (!gameState) return;
        gameRooms[gameId] = gameState;
        io.sockets.sockets.get(inviterId)?.join(gameId);
        io.sockets.sockets.get(opponentId)?.join(gameId);


        io.to(gameId).emit('gameStarted', { game, gameId, playerNames, role: gameState.playerInfo ? gameState.playerInfo[socket.id].role : null });
        io.to(gameId).emit('gameState', { gameId, state: gameState });
        if (['snake', 'air-hockey'].includes(game)) startGameLoop(gameId, game);
        delete activeInvites[inviteId];
    });
    
    socket.on('declineInvite', (inviteId) => {
        const invite = activeInvites[inviteId];
        if (invite) {
            io.to(invite.inviterId).emit('gameMessage', `${users[invite.opponentId]} declined your invitation.`);
            delete activeInvites[inviteId];
        }
    });

    socket.on('ticTacToeMove', ({ gameId, index }) => {
        const game = gameRooms[gameId];
        if (!game || game.winner || game.currentPlayer !== socket.id || game.board[index] !== null) return;
        
        game.board[index] = game.players[socket.id];
        game.turnCount++;
        
        const winPatterns = [[0,1,2], [3,4,5], [6,7,8], [0,3,6], [1,4,7], [2,5,8], [0,4,8], [2,4,6]];
        for (const p of winPatterns) {
            if (game.board[p[0]] && game.board[p[0]] === game.board[p[1]] && game.board[p[0]] === game.board[p[2]]) {
                game.winner = game.playerNames[socket.id];
                break;
            }
        }

        if (game.winner) {
            io.to(gameId).emit('gameOver', { gameId, message: `${game.winner} wins!` });
            delete gameRooms[gameId];
        } else if (game.turnCount === 9) {
            io.to(gameId).emit('gameOver', { gameId, message: "It's a draw!" });
            delete gameRooms[gameId];
        } else {
            game.currentPlayer = Object.keys(game.players).find(id => id !== socket.id);
            io.to(gameId).emit('gameState', { gameId, state: game });
        }
    });

    socket.on('rpsMove', ({ gameId, move }) => {
        const game = gameRooms[gameId];
        if (!game || game.players[socket.id].move) return;
        game.players[socket.id].move = move;
        const [p1Id, p2Id] = Object.keys(game.players);
        
        if (game.players[p1Id].move && game.players[p2Id].move) {
            const move1 = game.players[p1Id].move;
            const move2 = game.players[p2Id].move;
            let winnerId = null;
            if (move1 !== move2) {
                if ((move1 === 'rock' && move2 === 'scissors') || (move1 === 'paper' && move2 === 'rock') || (move1 === 'scissors' && move2 === 'paper')) {
                    winnerId = p1Id;
                } else {
                    winnerId = p2Id;
                }
            }
            if(winnerId) game.players[winnerId].score++;
            const resultMsg = winnerId ? `${game.playerNames[winnerId]} wins the round!` : "It's a tie for this round!";
            
            io.to(gameId).emit('roundResult', { result: resultMsg, scores: { [p1Id]: game.players[p1Id].score, [p2Id]: game.players[p2Id].score } });
            
            game.players[p1Id].move = null;
            game.players[p2Id].move = null;
        } else {
            socket.emit('gameMessage', `You chose ${move}. Waiting for opponent...`);
        }
    });

    socket.on('setNumber', ({ gameId, number }) => {
        const game = gameRooms[gameId];
        if (!game || game.setter !== socket.id || game.targetNumber !== null) return;
        game.targetNumber = parseInt(number);
        if (isNaN(game.targetNumber) || game.targetNumber < 1 || game.targetNumber > 100) {
            socket.emit('gameMessage', 'Please set a valid number between 1 and 100.');
            game.targetNumber = null;
            return;
        }
        game.feedback = `${game.playerNames[game.guesser]}, it's your turn to guess!`;
        io.to(gameId).emit('gameState', { gameId, state: game });
    });

    socket.on('guessNumber', ({ gameId, guess }) => {
        const game = gameRooms[gameId];
        if (!game || game.guesser !== socket.id || game.targetNumber === null) return;
        const parsedGuess = parseInt(guess);
        if (isNaN(parsedGuess)) return;
        game.attempts++;
        if (parsedGuess === game.targetNumber) {
            const message = `${game.playerNames[socket.id]} guessed the number ${game.targetNumber} in ${game.attempts} attempts!`;
            io.to(gameId).emit('gameOver', { gameId, message });
            delete gameRooms[gameId];
        } else if (game.attempts >= game.maxAttempts) {
            const message = `Out of attempts! The number was ${game.targetNumber}.`;
            io.to(gameId).emit('gameOver', { gameId, message });
            delete gameRooms[gameId];
        } else {
            game.feedback = `Guess: ${parsedGuess}. Try ${parsedGuess < game.targetNumber ? 'higher' : 'lower'}. Attempts left: ${game.maxAttempts - game.attempts}`;
            io.to(gameId).emit('gameState', { gameId, state: game });
        }
    });
    
    socket.on('palermoAction', ({ gameId, targetId }) => {
        const game = gameRooms[gameId];
        if (!game || !game.playerInfo[socket.id].alive || !targetId) return;
    
        if (game.phase === 'day' && !game.votes[socket.id]) {
            game.votes[socket.id] = targetId;
            const votesCount = Object.keys(game.votes).length;
            io.to(gameId).emit('gameMessage', `${game.playerInfo[socket.id].username} has voted. (${votesCount}/${game.alivePlayerIds.length})`);
            if (votesCount === game.alivePlayerIds.length) {
                processPalermoVotes(gameId);
            }
        } else if (game.phase === 'night' && game.playerInfo[socket.id].role === 'Killer') {
            processPalermoKill(gameId, targetId);
        }
    });

    socket.on('memoryFlip', ({ gameId, index }) => {
        const game = gameRooms[gameId];
        if (!game || game.currentPlayer !== socket.id || game.lockBoard || game.board[index].flipped) return;
        
        game.board[index].flipped = true;
        game.flippedIndices.push(index);

        if (game.flippedIndices.length === 2) {
            game.lockBoard = true;
            const [idx1, idx2] = game.flippedIndices;
            if (game.board[idx1].emoji === game.board[idx2].emoji) {
                game.board[idx1].matched = true;
                game.board[idx2].matched = true;
                game.scores[socket.id]++;
                game.matchedPairs++;
                game.flippedIndices = [];
                game.lockBoard = false;
                if (game.matchedPairs === game.board.length / 2) {
                    const [p1, p2] = game.players;
                    const p1s = game.scores[p1], p2s = game.scores[p2];
                    let msg = p1s === p2s ? "It's a draw!" : `${game.playerNames[p1s > p2s ? p1 : p2]} wins!`;
                    io.to(gameId).emit('gameOver', { gameId, message: `All pairs found! ${msg}` });
                    delete gameRooms[gameId];
                    return;
                }
            } else {
                setTimeout(() => {
                    if (gameRooms[gameId]) { // ΔΙΟΡΘΩΣΗ: Έλεγχος αν υπάρχει το παιχνίδι
                        game.board[idx1].flipped = false;
                        game.board[idx2].flipped = false;
                        game.currentPlayer = game.players.find(id => id !== socket.id);
                        game.flippedIndices = [];
                        game.lockBoard = false;
                        io.to(gameId).emit('gameState', { gameId, state: game });
                    }
                }, 1200);
            }
        }
        io.to(gameId).emit('gameState', { gameId, state: game });
    });

    socket.on('snakeChangeDirection', ({ gameId, mousePos }) => {
        const game = gameRooms[gameId];
        if (!game || !game.players[socket.id] || !game.players[socket.id].alive) return;
        const player = game.players[socket.id];
        const head = player.snake[0];
        const headScreenX = head.x * (500 / game.gridSize);
        const headScreenY = head.y * (500 / game.gridSize);
        const dx = mousePos.x - headScreenX;
        const dy = mousePos.y - headScreenY;
        let newDir = player.dir;
        if (Math.abs(dx) > Math.abs(dy)) {
            newDir = dx > 0 ? 'right' : 'left';
        } else {
            newDir = dy > 0 ? 'down' : 'up';
        }
        if (!((newDir === 'up' && player.dir === 'down') || (newDir === 'down' && player.dir === 'up') || (newDir === 'left' && player.dir === 'right') || (newDir === 'right' && player.dir === 'left'))) {
            player.dir = newDir;
        }
    });
    
    socket.on('airHockeyPaddleMove', ({ gameId, pos }) => {
        const game = gameRooms[gameId];
        if (!game || !game.paddles[socket.id]) return;
        const p = game.paddles[socket.id];
        // Περιορισμός X (όπως πριν)
        p.x = Math.max(p.r, Math.min(game.width - p.r, pos.x));
        // Περιορισμός Y ανάλογα με το αν είναι ο κάτω ή ο πάνω παίκτης
        const [p1Id, p2Id] = Object.keys(game.paddles);
        if (socket.id === p1Id) {
            // Κάτω παίκτης: μόνο στο κάτω μισό
            p.y = Math.max(game.height / 2, Math.min(game.height - p.r, pos.y));
        } else {
            // Πάνω παίκτης: μόνο στο πάνω μισό
            p.y = Math.max(p.r, Math.min(game.height / 2, pos.y));
        }
    });

    socket.on('disconnect', () => {
        const username = users[socket.id];
        if (!username) return;
        delete users[socket.id];
        io.emit('userLeft', { username, users: Object.keys(users).map(id => ({ id, username: users[id] })) });
        for (const gameId in gameRooms) {
            const game = gameRooms[gameId];
            const pIds = Array.isArray(game.players) ? game.players : Object.keys(game.players || {});
            if (pIds.includes(socket.id)) {
                if(game.loop) clearInterval(game.loop);
                io.to(gameId).emit('gameOver', { gameId, message: `${username} disconnected. Game over!` });
                delete gameRooms[gameId];
            }
        }
    });
});

function startGameLoop(gameId, gameType) {
    const interval = gameType === 'snake' ? 120 : 16;
    gameRooms[gameId].loop = setInterval(() => {
        const game = gameRooms[gameId];
        if (!game) { 
            clearInterval(gameRooms[gameId]?.loop); // ΔΙΟΡΘΩΣΗ: Καθαρισμός interval
            return; 
        }
        if (gameType === 'snake') updateSnake(gameId);
        if (gameType === 'air-hockey') updateAirHockey(gameId);
        if(gameRooms[gameId]) io.to(gameId).emit('gameState', { gameId, state: game });
    }, interval);
}

function updateSnake(gameId) {
    const game = gameRooms[gameId];
    if (!game) return;
    const allPlayers = Object.values(game.players);
    const allSegments = allPlayers.flatMap(p => p.snake);
    for (const pId in game.players) {
        const player = game.players[pId];
        if (!player.alive) continue;
        const head = { ...player.snake[0] };
        if (player.dir === 'up') head.y--; else if (player.dir === 'down') head.y++;
        if (player.dir === 'left') head.x--; else if (player.dir === 'right') head.x++;
        if (head.x < 0 || head.y < 0 || head.x >= game.gridSize || head.y >= game.gridSize || allSegments.some(s => s.x === head.x && s.y === head.y)) {
            player.alive = false;
            continue;
        }
        player.snake.unshift(head);
        if (head.x === game.food.x && head.y === game.food.y) {
            game.food.x = Math.floor(Math.random() * game.gridSize);
            game.food.y = Math.floor(Math.random() * game.gridSize);
        } else {
            player.snake.pop();
        }
    }
    if (allPlayers.filter(p => p.alive).length <= 1) {
        clearInterval(game.loop);
        const winner = allPlayers.find(p => p.alive);
        const message = winner ? `${game.playerNames[Object.keys(game.players).find(id => game.players[id] === winner)]} wins!` : "It's a draw!";
        io.to(gameId).emit('gameOver', { gameId, message });
        delete gameRooms[gameId];
    }
}

function updateAirHockey(gameId) {
    const game = gameRooms[gameId];
    if (!game) return;
    const { puck, paddles, width, height, scores } = game;
    puck.x += puck.vx; puck.y += puck.vy; puck.vx *= 0.99; puck.vy *= 0.99;
    if (puck.x < puck.r || puck.x > width - puck.r) { puck.vx *= -1; puck.x = puck.x < puck.r ? puck.r : width - puck.r; }
    const [p1Id, p2Id] = Object.keys(paddles);
    const goalWidth = 100;
    if (puck.y < puck.r) {
        if (puck.x > (width-goalWidth)/2 && puck.x < (width+goalWidth)/2) { scores[p1Id]++; resetAirHockey(gameId, p2Id); } else { puck.vy *= -1; puck.y = puck.r;}
    } else if (puck.y > height - puck.r) {
        if (puck.x > (width-goalWidth)/2 && puck.x < (width+goalWidth)/2) { scores[p2Id]++; resetAirHockey(gameId, p1Id); } else { puck.vy *= -1; puck.y = height - puck.r;}
    }
    for (const pId in paddles) {
        const p = paddles[pId];
        const dx = puck.x - p.x, dy = puck.y - p.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < puck.r + p.r) {
            const angle = Math.atan2(dy, dx);
            const speed = Math.sqrt(puck.vx*puck.vx + puck.vy*puck.vy) + 1;
            puck.vx = Math.cos(angle) * speed; puck.vy = Math.sin(angle) * speed;
        }
    }
    if (scores[p1Id] >= 5 || scores[p2Id] >= 5) {
        clearInterval(game.loop);
        const winner = scores[p1Id] >= 5 ? game.playerNames[p1Id] : game.playerNames[p2Id];
        io.to(gameId).emit('gameOver', { gameId, message: `${winner} wins!` });
        delete gameRooms[gameId];
    }
}

function resetAirHockey(gameId, serveToId) {
    const game = gameRooms[gameId];
    if (!game) return;
    game.puck.x = game.width/2; game.puck.y = game.height/2; game.puck.vx = 0;
    game.puck.vy = game.paddles[serveToId].y > game.height/2 ? -3 : 3;
}

function processPalermoVotes(gameId) {
    const game = gameRooms[gameId];
    if (!game) return;
    const voteCounts = { [game.alivePlayerIds[0]]: 0, [game.alivePlayerIds[1]]: 0 };
    Object.values(game.votes).forEach(votedId => { if(votedId in voteCounts) voteCounts[votedId]++; });
    let maxVotes = 0, playersToElim = [];
    for (const pId in voteCounts) {
        if (voteCounts[pId] > maxVotes) { maxVotes = voteCounts[pId]; playersToElim = [pId]; }
        else if (voteCounts[pId] === maxVotes) { playersToElim.push(pId); } // ΔΙΟΡΘΩΣΗ: push() αντί για push[]
    }
    if (playersToElim.length === 1) {
        const elimId = playersToElim[0];
        game.playerInfo[elimId].alive = false;
        game.alivePlayerIds = game.alivePlayerIds.filter(id => id !== elimId);
        game.message = `${game.playerInfo[elimId].username} was eliminated! They were a ${game.playerInfo[elimId].role}.`;
        checkPalermoWin(gameId);
    } else {
        game.message = 'The vote was tied. No one was eliminated. It is now night.';
        game.phase = 'night';
        io.to(gameId).emit('gameState', { gameId, state: game });
    }
    game.votes = {};
}

function processPalermoKill(gameId, targetId) {
    const game = gameRooms[gameId];
    if (!game || !targetId) return;
    game.playerInfo[targetId].alive = false;
    game.alivePlayerIds = game.alivePlayerIds.filter(id => id !== targetId);
    game.message = `The Killer has acted! It is now day.`;
    game.phase = 'day';
    checkPalermoWin(gameId);
}

function checkPalermoWin(gameId) {
    const game = gameRooms[gameId];
    if (!game) return;
    const killers = game.alivePlayerIds.filter(id => game.playerInfo[id].role === 'Killer').length;
    const citizens = game.alivePlayerIds.filter(id => game.playerInfo[id].role === 'Citizen').length;
    let winner = null;
    if (killers === 0) winner = 'Citizens win!';
    if (killers >= citizens) winner = 'Killers win!';
    if (winner) {
        io.to(gameId).emit('gameOver', { gameId, message: winner });
        delete gameRooms[gameId];
    } else {
        io.to(gameId).emit('gameState', { gameId, state: game });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));