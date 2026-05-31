import http from 'http';
import { WebSocketServer } from 'ws';
// @ts-ignore
import { setupWSConnection } from 'y-websocket/bin/utils';

const port = process.env.PORT || 3001;

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('Yjs Collaboration Server\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (conn, req) => {
  // Extract room/projectId from URL
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const roomName = url.pathname.slice(1) || 'default-room';

  console.log(`[Collab] User connected to room: ${roomName}`);
  
  setupWSConnection(conn, req, { docName: roomName, gc: true });
});

server.listen(port, () => {
  console.log(`[Collab] Server running on port ${port}`);
});
