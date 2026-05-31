// ============================================
// AI CODE STUDIO - BACKEND SERVER (EXAMPLE)
// Node.js + Fastify + WebSocket
// ============================================

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import jwt from '@fastify/jwt';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import * as Y from 'yjs';

// Initialize
const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL!);
const pubsub = new Redis(process.env.REDIS_URL!);

// ============================================
// PLUGINS
// ============================================

fastify.register(cors, {
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
});

fastify.register(jwt, {
  secret: process.env.JWT_SECRET!,
});

fastify.register(websocket);

// ============================================
// AUTH ROUTES
// ============================================

fastify.post('/api/auth/github', async (request, reply) => {
  const { code } = request.body as { code: string };
  
  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  
  const { access_token } = await tokenResponse.json();
  
  // Get user info
  const userResponse = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  
  const githubUser = await userResponse.json();
  
  // Upsert user
  const user = await prisma.user.upsert({
    where: { githubId: String(githubUser.id) },
    update: { name: githubUser.name, avatar: githubUser.avatar_url },
    create: {
      githubId: String(githubUser.id),
      email: githubUser.email || `${githubUser.id}@github.local`,
      name: githubUser.name || githubUser.login,
      avatar: githubUser.avatar_url,
    },
  });
  
  // Generate JWT
  const token = fastify.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
  
  return { token, user };
});

fastify.get('/api/auth/me', {
  preHandler: [authenticate],
}, async (request) => {
  const user = await prisma.user.findUnique({
    where: { id: request.user.userId },
  });
  return { user };
});

// ============================================
// PROJECT ROUTES
// ============================================

fastify.get('/api/projects', {
  preHandler: [authenticate],
}, async (request) => {
  const projects = await prisma.project.findMany({
    where: { ownerId: request.user.userId },
    orderBy: { updatedAt: 'desc' },
  });
  return { projects };
});

fastify.post('/api/projects', {
  preHandler: [authenticate],
}, async (request) => {
  const { name, description } = request.body as { name: string; description?: string };
  
  const project = await prisma.project.create({
    data: {
      name,
      description,
      ownerId: request.user.userId,
    },
  });
  
  return { project };
});

fastify.get('/api/projects/:id/files', {
  preHandler: [authenticate],
}, async (request) => {
  const { id } = request.params as { id: string };
  
  const files = await prisma.file.findMany({
    where: { projectId: id },
    orderBy: { path: 'asc' },
  });
  
  return { files };
});

// ============================================
// FILE ROUTES
// ============================================

fastify.put('/api/files/:id', {
  preHandler: [authenticate],
}, async (request) => {
  const { id } = request.params as { id: string };
  const { content } = request.body as { content: string };
  
  // Save current version
  const file = await prisma.file.findUnique({ where: { id } });
  if (file?.content) {
    await prisma.fileVersion.create({
      data: {
        fileId: id,
        content: file.content,
        hash: crypto.createHash('sha256').update(file.content).digest('hex'),
      },
    });
  }
  
  // Update file
  const updated = await prisma.file.update({
    where: { id },
    data: {
      content,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
      updatedAt: new Date(),
    },
  });
  
  return { file: updated };
});

// ============================================
// GIT ROUTES
// ============================================

import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';

fastify.post('/api/git/clone', {
  preHandler: [authenticate],
}, async (request) => {
  const { url, branch } = request.body as { url: string; branch?: string };
  
  // Create project
  const project = await prisma.project.create({
    data: {
      name: path.basename(url, '.git'),
      ownerId: request.user.userId,
    },
  });
  
  // Clone repo
  const projectPath = path.join(process.env.DATA_PATH!, 'projects', project.id);
  await fs.mkdir(projectPath, { recursive: true });
  
  const git = simpleGit(projectPath);
  await git.clone(url, '.', branch ? ['--branch', branch] : []);
  
  // Create GitRepo record
  await prisma.gitRepo.create({
    data: {
      projectId: project.id,
      remoteUrl: url,
      branch: branch || 'main',
    },
  });
  
  // Index files
  await indexProjectFiles(project.id, projectPath);
  
  return { project };
});

fastify.post('/api/git/commit', {
  preHandler: [authenticate],
}, async (request) => {
  const { projectId, message, files } = request.body as {
    projectId: string;
    message: string;
    files: { path: string; content: string }[];
  };
  
  const projectPath = path.join(process.env.DATA_PATH!, 'projects', projectId);
  const git = simpleGit(projectPath);
  
  // Write files
  for (const file of files) {
    await fs.writeFile(path.join(projectPath, file.path), file.content);
    await git.add(file.path);
  }
  
  // Commit
  const commit = await git.commit(message);
  
  return { commit };
});

// ============================================
// CODE RUNNER
// ============================================

fastify.post('/api/code/run', {
  preHandler: [authenticate],
}, async (request) => {
  const { language, code, stdin, timeout = 10 } = request.body as {
    language: string;
    code: string;
    stdin?: string;
    timeout?: number;
  };
  
  // Forward to code runner service
  const response = await fetch(`${process.env.CODE_RUNNER_URL}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, code, stdin, timeout }),
  });
  
  return response.json();
});

// ============================================
// AI SERVICE
// ============================================

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function streamAIResponse(
  messages: { role: string; content: string }[],
  context: string | null,
  onChunk: (chunk: string) => void
) {
  const systemPrompt = `You are an expert AI coding assistant. Help users write, debug, and improve their code.
${context ? `\n\nProject context:\n${context}` : ''}`;

  const stream = await openai.chat.completions.create({
    model: 'gpt-4-turbo-preview',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      onChunk(content);
    }
  }
}

async function getCodeCompletion(prefix: string, suffix: string, language: string) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mixtral-8x7b-32768',
      messages: [
        {
          role: 'system',
          content: `Complete the ${language} code. Return ONLY the completion, no explanation.`,
        },
        {
          role: 'user',
          content: `${prefix}<CURSOR>${suffix}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.1,
    }),
  });

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

// ============================================
// WEBSOCKET HANDLERS
// ============================================

// Store for Yjs documents
const docs = new Map<string, Y.Doc>();
const awareness = new Map<string, Map<string, any>>();

fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    const token = new URL(req.url!, 'http://localhost').searchParams.get('token');
    const projectId = new URL(req.url!, 'http://localhost').searchParams.get('projectId');
    
    let userId: string;
    
    try {
      const decoded = fastify.jwt.verify(token!) as { userId: string };
      userId = decoded.userId;
    } catch {
      connection.socket.close(4001, 'Unauthorized');
      return;
    }
    
    // Subscribe to project channel
    pubsub.subscribe(`project:${projectId}`);
    
    connection.socket.on('message', async (rawMessage) => {
      const message = JSON.parse(rawMessage.toString());
      
      switch (message.type) {
        case 'collab:join': {
          // Get or create Yjs doc
          if (!docs.has(projectId!)) {
            docs.set(projectId!, new Y.Doc());
          }
          
          // Send current state
          const doc = docs.get(projectId!)!;
          const state = Y.encodeStateAsUpdate(doc);
          connection.socket.send(JSON.stringify({
            type: 'collab:sync',
            payload: { state: Buffer.from(state).toString('base64') },
          }));
          break;
        }
        
        case 'collab:edit': {
          const { update } = message.payload;
          const doc = docs.get(projectId!);
          if (doc) {
            Y.applyUpdate(doc, Buffer.from(update, 'base64'));
            // Broadcast to all clients
            redis.publish(`project:${projectId}`, JSON.stringify({
              type: 'collab:update',
              payload: { update },
            }));
          }
          break;
        }
        
        case 'collab:cursor': {
          redis.publish(`project:${projectId}`, JSON.stringify({
            type: 'collab:cursors',
            payload: { userId, ...message.payload },
          }));
          break;
        }
        
        case 'ai:completion': {
          const { requestId, prefix, suffix, language } = message.payload;
          const completion = await getCodeCompletion(prefix, suffix, language);
          connection.socket.send(JSON.stringify({
            type: 'ai:completion:chunk',
            payload: { requestId, chunk: completion, done: true },
          }));
          break;
        }
        
        case 'ai:chat:stream': {
          const { requestId, messages, context } = message.payload;
          await streamAIResponse(messages, context, (chunk) => {
            connection.socket.send(JSON.stringify({
              type: 'ai:chat:chunk',
              payload: { requestId, chunk },
            }));
          });
          connection.socket.send(JSON.stringify({
            type: 'ai:chat:end',
            payload: { requestId },
          }));
          break;
        }
      }
    });
    
    // Handle Redis pub/sub messages
    pubsub.on('message', (channel, message) => {
      if (channel === `project:${projectId}`) {
        connection.socket.send(message);
      }
    });
    
    connection.socket.on('close', () => {
      pubsub.unsubscribe(`project:${projectId}`);
    });
  });
});

// ============================================
// HELPERS
// ============================================

async function authenticate(request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

async function indexProjectFiles(projectId: string, projectPath: string) {
  const entries = await fs.readdir(projectPath, { withFileTypes: true, recursive: true });
  
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    
    const filePath = path.relative(projectPath, path.join(entry.path, entry.name));
    
    if (entry.isFile()) {
      const content = await fs.readFile(path.join(projectPath, filePath), 'utf-8');
      await prisma.file.create({
        data: {
          projectId,
          path: filePath,
          name: entry.name,
          type: 'FILE',
          content,
          hash: crypto.createHash('sha256').update(content).digest('hex'),
        },
      });
    }
  }
}

// ============================================
// START SERVER
// ============================================

const start = async () => {
  try {
    await prisma.$connect();
    await fastify.listen({ port: parseInt(process.env.PORT || '3000'), host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
