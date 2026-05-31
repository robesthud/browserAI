// ============================================
// AI CODE STUDIO - WEBSOCKET HANDLERS
// Chat streaming, collaboration, browser agent
// ============================================
import { WebSocket } from 'ws';
import { AIAdapter } from '../services/aiAdapter.js';
import { prisma } from '../index.js';
import { agentQueue } from '../services/queues.js';
import { randomUUID } from 'crypto';
import * as Y from 'yjs';
// Store for Yjs documents
const docs = new Map();
const connections = new Map();
export const activeAgentSockets = new Map();
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
                    await handleMessage(ws, message, { userId, projectId });
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
            // Forward to browser agent service
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
            try {
                // Register WebSocket for live updates
                activeAgentSockets.set(taskId, ws);
                // Create task tracking in DB
                const task = await prisma.agentTask.create({
                    data: {
                        id: taskId,
                        projectId,
                        userId: ctx.userId || 'demo-user-1',
                        goal,
                        status: 'pending',
                    }
                });
                // Add task to Bull Queue (processed in background by Redis)
                await agentQueue.add('agent-task', {
                    taskId,
                    projectId,
                    goal,
                    config,
                });
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
async function planAgentTask(goal, config) {
    // Use AI to plan steps
    const messages = [
        {
            role: 'system',
            content: `You are a project planning AI. Given a goal, output a JSON array of steps to achieve it.
Each step should have: id, type (create_file, edit_file, run_command, install), description, and details.
Output only valid JSON, no markdown.`,
        },
        {
            role: 'user',
            content: `Plan steps to: ${goal}`,
        },
    ];
    try {
        const response = await AIAdapter.chat(config, messages);
        return JSON.parse(response);
    }
    catch {
        // Fallback to basic steps
        return [
            { id: '1', type: 'plan', description: `Planning: ${goal}` },
            { id: '2', type: 'create_file', description: 'Creating project structure' },
            { id: '3', type: 'complete', description: 'Task completed' },
        ];
    }
}
async function executeAgentStep(step, _config) {
    // Execute different step types
    switch (step.type) {
        case 'create_file':
            return { success: true, file: step.details?.path };
        case 'run_command':
            return { success: true, output: 'Command executed' };
        case 'install':
            return { success: true, packages: step.details?.packages };
        default:
            return { success: true };
    }
}
