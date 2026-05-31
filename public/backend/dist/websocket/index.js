// ============================================
// AI CODE STUDIO - WEBSOCKET HANDLERS
// Chat streaming, collaboration, browser agent, and background ReAct Agent updates
// ============================================
import { WebSocket } from 'ws';
import { AIAdapter } from '../services/aiAdapter.js';
import { prisma } from '../index.js';
import { agentQueue } from '../services/agentQueue.js';
import { PTYManager } from '../services/ptyManager.js';
import { randomUUID } from 'crypto';
import * as Y from 'yjs';
// Global map matching task IDs to their active Websockets for real-time streaming feedback
export const activeAgentSockets = new Map();
const docs = new Map();
const connections = new Map();
export function setupWebSocket(fastify) {
    fastify.register(async function (fastify) {
        fastify.get('/ws', { websocket: true }, (connection, req) => {
            const ws = connection.socket;
            const url = new URL(req.url, `http://${req.headers.host}`);
            const token = url.searchParams.get('token');
            const projectId = url.searchParams.get('projectId');
            let userId = null;
            // Verify JWT
            if (token) {
                try {
                    const decoded = fastify.jwt.verify(token);
                    userId = decoded.userId;
                }
                catch {
                    ws.close(4001, 'Unauthorized');
                    return;
                }
            }
            // Add to project connections
            if (projectId) {
                if (!connections.has(projectId)) {
                    connections.set(projectId, new Set());
                }
                connections.get(projectId).add(ws);
            }
            // Handle messages
            ws.on('message', async (rawMessage) => {
                try {
                    const message = JSON.parse(rawMessage.toString());
                    await handleMessage(ws, message, { userId, projectId, host: req.headers.host || 'localhost', token: token || '' });
                }
                catch (error) {
                    console.error('WebSocket message error:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        payload: { message: 'Invalid message format' },
                    }));
                }
            });
            // Handle disconnect
            ws.on('close', () => {
                if (projectId) {
                    connections.get(projectId)?.delete(ws);
                    // Force gracefully kill the PTY session associated with this WebSocket on close
                    const ptySessionId = `${projectId}-${userId || 'guest'}`;
                    PTYManager.killSession(ptySessionId);
                }
                // Clean up active sockets
                for (const [taskId, socket] of activeAgentSockets.entries()) {
                    if (socket === ws) {
                        activeAgentSockets.delete(taskId);
                    }
                }
            });
        });
    });
}
async function handleMessage(ws, message, ctx) {
    const { type, payload } = message;
    switch (type) {
        // ============================================
        // AI CHAT
        // ============================================
        case 'ai:chat:stream': {
            const { requestId, messages, context, config } = payload;
            // Add context to system message if provided
            if (context) {
                const systemIdx = messages.findIndex(m => m.role === 'system');
                if (systemIdx >= 0) {
                    messages[systemIdx].content += `\n\nProject context:\n${context}`;
                }
                else {
                    messages.unshift({
                        role: 'system',
                        content: `You are a helpful AI coding assistant.\n\nProject context:\n${context}`,
                    });
                }
            }
            try {
                await AIAdapter.streamChat(config, messages, {
                    onToken: (token) => {
                        ws.send(JSON.stringify({
                            type: 'ai:chat:chunk',
                            payload: { requestId, chunk: token },
                        }));
                    },
                    onComplete: (fullText) => {
                        ws.send(JSON.stringify({
                            type: 'ai:chat:end',
                            payload: { requestId, fullText },
                        }));
                    },
                    onError: (error) => {
                        ws.send(JSON.stringify({
                            type: 'ai:chat:error',
                            payload: { requestId, error: error.message },
                        }));
                    },
                });
            }
            catch (error) {
                ws.send(JSON.stringify({
                    type: 'ai:chat:error',
                    payload: { requestId, error: String(error) },
                }));
            }
            break;
        }
        // ============================================
        // AI AUTOCOMPLETE
        // ============================================
        case 'ai:completion': {
            const { requestId, prefix, suffix, language, config } = payload;
            try {
                const completion = await AIAdapter.complete(config, prefix, suffix, language);
                ws.send(JSON.stringify({
                    type: 'ai:completion:result',
                    payload: { requestId, completion },
                }));
            }
            catch (error) {
                ws.send(JSON.stringify({
                    type: 'ai:completion:error',
                    payload: { requestId, error: String(error) },
                }));
            }
            break;
        }
        // ============================================
        // COLLABORATION (CRDT)
        // ============================================
        case 'collab:join': {
            const { projectId: pid, userName } = payload;
            // Get or create Yjs doc
            if (!docs.has(pid)) {
                docs.set(pid, new Y.Doc());
            }
            // Send current state
            const doc = docs.get(pid);
            const state = Y.encodeStateAsUpdate(doc);
            ws.send(JSON.stringify({
                type: 'collab:sync',
                payload: { state: Buffer.from(state).toString('base64') },
            }));
            // Broadcast join
            broadcast(pid, ws, {
                type: 'collab:user:joined',
                payload: { userId: ctx.userId, userName },
            });
            break;
        }
        case 'collab:edit': {
            const { projectId: pid, update } = payload;
            const doc = docs.get(pid);
            if (doc) {
                // Apply update
                Y.applyUpdate(doc, Buffer.from(update, 'base64'));
                // Broadcast to all other clients
                broadcast(pid, ws, {
                    type: 'collab:update',
                    payload: { update },
                });
            }
            break;
        }
        case 'collab:cursor': {
            const { projectId: pid, cursor } = payload;
            // Broadcast cursor position
            broadcast(pid, ws, {
                type: 'collab:cursors',
                payload: { userId: ctx.userId, cursor },
            });
            break;
        }
        // ============================================
        // BROWSER AGENT
        // ============================================
        case 'browser:action': {
            const { requestId, action } = payload;
            try {
                const response = await fetch(`${process.env.BROWSER_AI_URL || 'http://localhost:8080'}/action`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(action),
                });
                const result = await response.json();
                ws.send(JSON.stringify({
                    type: 'browser:result',
                    payload: { requestId, result },
                }));
            }
            catch (error) {
                ws.send(JSON.stringify({
                    type: 'browser:error',
                    payload: { requestId, error: String(error) },
                }));
            }
            break;
        }
        // ============================================
        // AGENT TASKS (QUEUE ENABLED WITH BULL)
        // ============================================
        case 'agent:task': {
            const { goal, config } = payload;
            const taskId = randomUUID();
            const projectId = ctx.projectId || 'demo-project-1';
            const wsUrl = `ws://${ctx.host}/ws?token=${ctx.token}&projectId=${projectId}`;
            try {
                // Save the active WebSocket connection to map for streaming updates
                activeAgentSockets.set(taskId, ws);
                // Create Task tracker row in Postgres/SQLite database
                await prisma.agentTask.create({
                    data: {
                        id: taskId,
                        projectId,
                        userId: ctx.userId || 'demo-user-1',
                        goal,
                        status: 'pending',
                    }
                });
                // Add execution task to Bull queue
                await agentQueue.add('agent-task', {
                    taskId,
                    projectId,
                    goal,
                    config,
                    wsUrl,
                });
                // Notify client that task is successfully queued
                ws.send(JSON.stringify({
                    type: 'agent:queued',
                    payload: { taskId, status: 'pending', message: 'Task queued for background execution' }
                }));
            }
            catch (err) {
                ws.send(JSON.stringify({
                    type: 'agent:error',
                    payload: { error: err.message || String(err) }
                }));
            }
            break;
        }
        // ============================================
        // REAL-TIME PTY TERMINAL WORKFLOW
        // ============================================
        case 'terminal:init': {
            const ptySessionId = `${ctx.projectId || 'default'}-${ctx.userId || 'guest'}`;
            try {
                await PTYManager.createSession(ptySessionId, ctx.projectId || 'default', ws);
            }
            catch (err) {
                ws.send(JSON.stringify({
                    type: 'terminal:output',
                    payload: { sessionId: ptySessionId, data: `\r\n\x1b[31m[PTY Error] Failed to launch terminal shell: ${err.message}\x1b[0m\r\n` }
                }));
            }
            break;
        }
        case 'terminal:input': {
            const ptySessionId = `${ctx.projectId || 'default'}-${ctx.userId || 'guest'}`;
            PTYManager.write(ptySessionId, payload.data);
            break;
        }
        case 'terminal:resize': {
            const ptySessionId = `${ctx.projectId || 'default'}-${ctx.userId || 'guest'}`;
            PTYManager.resize(ptySessionId, payload.cols, payload.rows);
            break;
        }
        default:
            console.log('Unknown message type:', type);
    }
}
// ============================================
// HELPERS
// ============================================
function broadcast(projectId, excludeWs, message) {
    const projectConnections = connections.get(projectId);
    if (projectConnections) {
        const msgStr = JSON.stringify(message);
        for (const ws of projectConnections) {
            if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
                ws.send(msgStr);
            }
        }
    }
}
export default setupWebSocket;
