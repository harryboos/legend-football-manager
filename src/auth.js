const crypto = require('crypto');
const {promisify} = require('util');
const {createJsonStore} = require('./storage');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);

function emptyState() {
  return {version: 1, users: {}, sessions: {}};
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

async function passwordHashAsync(password, salt) {
  return (await scrypt(String(password), salt, 32)).toString('hex');
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

function validateState(state) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(state) || !isRecord(state.users) || !isRecord(state.sessions)) throw new Error('账号数据结构无效');
  const usernames = new Set();
  for (const [id, user] of Object.entries(state.users)) {
    if (!isRecord(user) || user.id !== id || typeof user.username !== 'string'
      || user.usernameKey !== user.username.toLocaleLowerCase()
      || typeof user.passwordSalt !== 'string' || !/^[a-f0-9]{32}$/i.test(user.passwordSalt)
      || typeof user.passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(user.passwordHash)
      || usernames.has(user.usernameKey)) throw new Error('账号记录无效');
    usernames.add(user.usernameKey);
  }
  for (const [hash, record] of Object.entries(state.sessions)) {
    if (!/^[a-f0-9]{64}$/i.test(hash) || !isRecord(record)
      || typeof record.userId !== 'string' || !Number.isFinite(record.expiresAt)) throw new Error('登录会话记录无效');
  }
  return state;
}

function createFileState(file) {
  const store = createJsonStore(file, {empty: emptyState, validate: validateState, label: '账号数据'});
  const state = store.load();
  return {state, save: () => store.save(state)};
}

function createAuthService(options = {}) {
  const source = options.file ? createFileState(options.file) : {state: options.state || emptyState(), save: options.save || (() => {})};
  const state = source.state;
  state.users = state.users || {};
  state.sessions = state.sessions || {};
  validateState(state);
  const usersByName = new Map(Object.values(state.users).map(user => [user.usernameKey, user.id]));

  function save() {
    try {
      source.save();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.status = 500;
      throw failure;
    }
  }

  function findUser(username) {
    const key = String(username || '').trim().toLocaleLowerCase();
    return state.users[usersByName.get(key)];
  }

  function createSession(user, newUser = false) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    const now = Date.now();
    const expired = Object.entries(state.sessions).filter(([, record]) => record.expiresAt <= now || !Object.hasOwn(state.users, record.userId));
    for (const [key] of expired) delete state.sessions[key];
    state.sessions[hash] = {userId: user.id, expiresAt: now + SESSION_MAX_AGE_MS};
    if (newUser) state.users[user.id] = user;
    try {
      save();
    } catch (error) {
      delete state.sessions[hash];
      for (const [key, record] of expired) state.sessions[key] = record;
      if (newUser) delete state.users[user.id];
      throw error;
    }
    if (newUser) usersByName.set(user.usernameKey, user.id);
    return {token, user: publicUser(user)};
  }

  function registration(usernameValue, passwordValue) {
    const username = normalizeUsername(usernameValue);
    const password = validatePassword(passwordValue);
    if (findUser(username)) throw new Error('用户名已经存在');
    const salt = crypto.randomBytes(16).toString('hex');
    return {password, user: {
      id: crypto.randomBytes(12).toString('hex'),
      username,
      usernameKey: username.toLocaleLowerCase(),
      passwordSalt: salt,
      createdAt: new Date().toISOString()
    }};
  }

  function register(usernameValue, passwordValue) {
    const {password, user} = registration(usernameValue, passwordValue);
    user.passwordHash = passwordHash(password, user.passwordSalt);
    return createSession(user, true);
  }

  async function registerAsync(usernameValue, passwordValue) {
    const {password, user} = registration(usernameValue, passwordValue);
    user.passwordHash = await passwordHashAsync(password, user.passwordSalt);
    // Another registration may have finished while scrypt was running.
    if (findUser(user.username)) throw new Error('用户名已经存在');
    return createSession(user, true);
  }

  function login(usernameValue, passwordValue) {
    const username = normalizeUsername(usernameValue);
    const password = validatePassword(passwordValue);
    const user = findUser(username);
    if (!user || !safeEqual(user.passwordHash, passwordHash(password, user.passwordSalt))) throw new Error('用户名或密码错误');
    return createSession(user);
  }

  async function loginAsync(usernameValue, passwordValue) {
    const username = normalizeUsername(usernameValue);
    const password = validatePassword(passwordValue);
    const user = findUser(username);
    if (!user || !safeEqual(user.passwordHash, await passwordHashAsync(password, user.passwordSalt))) throw new Error('用户名或密码错误');
    return createSession(user);
  }

  function deleteSession(hash) {
    const record = state.sessions[hash];
    delete state.sessions[hash];
    try {
      save();
    } catch (error) {
      state.sessions[hash] = record;
      throw error;
    }
  }

  function session(token) {
    const hash = tokenHash(token);
    const record = state.sessions[hash];
    if (!record) return null;
    if (record.expiresAt <= Date.now() || !Object.hasOwn(state.users, record.userId)) {
      deleteSession(hash);
      return null;
    }
    const user = state.users[record.userId];
    return user ? {user: publicUser(user), expiresAt: record.expiresAt} : null;
  }

  function logout(token) {
    const hash = tokenHash(token);
    if (state.sessions[hash]) {
      deleteSession(hash);
    }
  }

  return {login, loginAsync, logout, register, registerAsync, session, state};
}

module.exports = {SESSION_MAX_AGE_MS, createAuthService};
