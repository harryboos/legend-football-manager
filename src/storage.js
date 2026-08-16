const fs = require('fs');
const path = require('path');
const {migrateGame} = require('./game');

function persistentGame(game) {
  const {players, availablePlayers, currentDraftTeam, table, topScorers, config, ...state} = game;
  return state;
}

function persistentGames(games) {
  return Object.fromEntries(Object.entries(games).map(([id, game]) => [id, persistentGame(game)]));
}

function readGames(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createGameStore(dataFile) {
  const backupFile = `${dataFile}.bak`;

  function load() {
    if (!fs.existsSync(dataFile)) return {};
    let games;
    try {
      games = readGames(dataFile);
    } catch (primaryError) {
      if (!fs.existsSync(backupFile)) throw new Error(`存档读取失败：${primaryError.message}`);
      try {
        games = readGames(backupFile);
      } catch (backupError) {
        throw new Error(`主存档与备份均无法读取：${backupError.message}`);
      }
    }
    Object.values(games).forEach(migrateGame);
    return games;
  }

  function save(games) {
    fs.mkdirSync(path.dirname(dataFile), {recursive: true});
    const temporaryFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(persistentGames(games), null, 2), 'utf8');
      if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, backupFile);
      fs.renameSync(temporaryFile, dataFile);
    } finally {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    }
  }

  return {load, save, dataFile, backupFile};
}

module.exports = {createGameStore, persistentGame, persistentGames};
