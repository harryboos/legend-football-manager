const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGames(games) {
  if (!isRecord(games)) throw new Error('存档必须是房间对象');
  for (const [id, game] of Object.entries(games)) {
    if (!isRecord(game) || game.id !== id || !Array.isArray(game.teams) || game.teams.length < 2
      || game.teams.some(team => !isRecord(team) || typeof team.id !== 'string' || !team.id)
      || new Set(game.teams.map(team => team.id)).size !== game.teams.length) {
      throw new Error(`房间 ${id} 的存档结构无效`);
    }
  }
  return games;
}

function persistentGame(game) {
  const {players, availablePlayers, currentDraftTeam, table, topScorers, config, ...state} = game;
  return state;
}

function persistentGames(games) {
  validateGames(games);
  return Object.fromEntries(Object.entries(games).map(([id, game]) => [id, persistentGame(game)]));
}

function createJsonStore(dataFile, {validate, empty, label = '存档'}) {
  const backupFile = `${dataFile}.bak`;
  let initialized = false;
  let previousSnapshot = null;

  function load() {
    const errors = [];
    for (const file of [dataFile, backupFile]) {
      try {
        const serialized = fs.readFileSync(file, 'utf8');
        const value = validate(JSON.parse(serialized));
        previousSnapshot = serialized;
        initialized = true;
        return value;
      } catch (error) {
        if (error.code !== 'ENOENT') errors.push(error);
      }
    }
    if (errors.length) throw new Error(`${label}与备份无法读取：${errors.map(error => error.message).join('；')}`);
    initialized = true;
    previousSnapshot = null;
    return empty();
  }

  function writeTemporary(file, serialized) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      return temporary;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function save(value) {
    // Serialize before touching either file; circular or invalid values leave both intact.
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`${label}无法序列化`);
    if (!initialized) load();
    fs.mkdirSync(path.dirname(dataFile), {recursive: true});
    const temporaryFiles = [];
    try {
      const temporaryFile = writeTemporary(dataFile, serialized);
      temporaryFiles.push(temporaryFile);
      if (previousSnapshot !== null) {
        // Back up the last validated snapshot, never a corrupt primary recovered by load().
        const temporaryBackup = writeTemporary(backupFile, previousSnapshot);
        temporaryFiles.push(temporaryBackup);
        fs.renameSync(temporaryBackup, backupFile);
      }
      fs.renameSync(temporaryFile, dataFile);
      previousSnapshot = serialized;
    } finally {
      for (const temporary of temporaryFiles) {
        try { fs.unlinkSync(temporary); } catch {}
      }
    }
  }

  return {load, save, dataFile, backupFile};
}

function createGameStore(dataFile) {
  const store = createJsonStore(dataFile, {
    empty: () => ({}),
    validate(games) {
      validateGames(games);
      const {migrateGame} = require('./game');
      Object.values(games).forEach(migrateGame);
      return games;
    }
  });
  return {...store, save: games => store.save(persistentGames(games))};
}

module.exports = {createGameStore, createJsonStore, persistentGame, persistentGames};
