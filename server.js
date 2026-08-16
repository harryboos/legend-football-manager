const http = require('http');
const path = require('path');
const cfg = require('./config');
const {createGameStore} = require('./src/storage');
const {createRequestHandler} = require('./src/api');
const {createDeepSeekMatchService} = require('./src/match-ai');

function createApplication(options = {}) {
  const dataFile = options.dataFile || path.join(__dirname, 'data', 'games.json');
  const publicDirectory = options.publicDirectory || path.join(__dirname, 'public');
  const store = options.store || createGameStore(dataFile);
  const games = options.games || store.load();
  const matchService = options.matchService || createDeepSeekMatchService();
  const handler = createRequestHandler({games, save: current => store.save(current), publicDirectory, matchService});
  return {server: http.createServer(handler), handler, games, store, matchService};
}

if (require.main === module) {
  const {server} = createApplication();
  server.listen(cfg.PORT, () => console.log(`传奇足球经理已启动：http://localhost:${cfg.PORT}`));
}

module.exports = {createApplication};
