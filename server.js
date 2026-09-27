const http = require('http');
const path = require('path');
const cfg = require('./config');
const {createGameStore} = require('./src/storage');
const {createRequestHandler} = require('./src/api');
const {createAuthService} = require('./src/auth');
const {createSiteGate} = require('./src/site-gate');
const {createDeepSeekMatchService} = require('./src/match-ai');

function createApplication(options = {}) {
  const dataFile = options.dataFile || path.join(__dirname, 'data', 'games.json');
  const publicDirectory = options.publicDirectory || path.join(__dirname, 'public');
  const store = options.store || createGameStore(dataFile);
  const games = options.games || store.load();
  const matchService = options.matchService || createDeepSeekMatchService();
  const auth = options.auth || createAuthService({file: options.authFile || path.join(__dirname, 'data', 'auth.json')});
  const siteGate = options.siteGate || createSiteGate(options.siteAccessKey === undefined ? cfg.SITE_ACCESS_KEY : options.siteAccessKey);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === 'true';
  const handler = createRequestHandler({games, save: current => store.save(current), publicDirectory, matchService, auth, siteGate, trustProxy});
  return {server: http.createServer(handler), handler, games, store, matchService, auth, siteGate};
}

if (require.main === module) {
  const {server} = createApplication();
  server.listen(cfg.PORT, () => console.log(`harryboos的个人项目已启动：http://localhost:${cfg.PORT}`));
}

module.exports = {createApplication};
