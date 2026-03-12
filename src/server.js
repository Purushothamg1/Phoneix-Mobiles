import http from 'node:http';
import { URL } from 'node:url';
import { PORT } from './lib/config.js';
import { handleRequest } from './routes/api.js';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  await handleRequest(req, res, url);
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'server_started', port: PORT, at: new Date().toISOString() }));
});
