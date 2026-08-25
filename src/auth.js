const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function emptyState() {
  return {version: 1, users: {}, sessions: {}};
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeUsername(value) {
  const username = String(value || '').trim();
  if (username.length < 3 || username.length > 24) throw new Error('用户名必须为 3 至 24 个字符');
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) throw new Error('用户名只能包含文字、数字、下划线或短横线');
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 6 || password.length > 72) throw new Error('登录密码必须为 6 至 72 个字符');
  return password;
}

function publicUser(user) {
  return {id: user.id, username: user.username, createdAt: user.createdAt};
}

function createFileState(file) {
  const backupFile = `${file}.bak`;
  let state = emptyState();
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (!fs.existsSync(backupFile)) throw new Error(`账号数据读取失败：${error.message}`);
      state = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    }
  }
  state.users = state.users && typeof state.users === 'object' ? state.users : {};
  state.sessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {};
  const save = () => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
      if (fs.existsSync(file)) fs.copyFileSync(file, backupFile);
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  return {state, save};
}

function createAuthService(options = {}) {
  const source = options.file ? createFileState(options.file) : {state: options.state || emptyState(), save: options.save || (() => {})};
  const state = source.state;
  state.users = state.users || {};
  state.sessions = state.sessions || {};

  function findUser(username) {
    const key = String(username || '').trim().toLocaleLowerCase();
    return Object.values(state.users).find(user => user.usernameKey === key);
  }

  function createSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    state.sessions[tokenHash(token)] = {userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE_MS};
    source.save();
    return {token, user: publicUser(user)};
  }

  function register(usernameValue, passwordValue) {
    const username = normalizeUsername(usernameValue);
    const password = validatePassword(passwordValue);
    if (findUser(username)) throw new Error('用户名已经存在');
    const id = crypto.randomBytes(12).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id,
      username,
      usernameKey: username.toLocaleLowerCase(),
      passwordSalt: salt,
      passwordHash: passwordHash(password, salt),
      createdAt: new Date().toISOString()
    };
    state.users[id] = user;
    return createSession(user);
  }

  function login(usernameValue, passwordValue) {
    const username = normalizeUsername(usernameValue);
    const password = validatePassword(passwordValue);
    const user = findUser(username);
    if (!user || !safeEqual(user.passwordHash, passwordHash(password, user.passwordSalt))) throw new Error('用户名或密码错误');
    return createSession(user);
  }

  function session(token) {
    const hash = tokenHash(token);
    const record = state.sessions[hash];
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      delete state.sessions[hash];
      source.save();
      return null;
    }
    const user = state.users[record.userId];
    return user ? {user: publicUser(user), expiresAt: record.expiresAt} : null;
  }

  function logout(token) {
    const hash = tokenHash(token);
    if (state.sessions[hash]) {
      delete state.sessions[hash];
      source.save();
    }
  }

  return {login, logout, register, session, state};
}

module.exports = {SESSION_MAX_AGE_MS, createAuthService};
