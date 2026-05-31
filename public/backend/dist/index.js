// ============================================
// AI CODE STUDIO - BACKEND SERVER
// Node.js + Fastify + WebSocket + Prisma
// ============================================
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';
// Routes
import { authRoutes } from './api/auth.js';
import { projectRoutes } from './api/projects.js';
import { fileRoutes } from './api/files.js';
import { gitRoutes } from './api/git.js';
import { codeRoutes } from './api/code.js';
import { settingsRoutes } from './api/settings.js';
import { proxyRoutes } from './api/proxy.js';
import { figmaRoutes } from './api/figma.js';
import { aiRoutes } from './api/ai.js';
// WebSocket handlers
import { setupWebSocket } from './websocket/index.js';
dotenv.config();
// SQLite Fallback if DEMO_MODE is active or DATABASE_URL is missing
if (process.env.DEMO_MODE === 'true' || !process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./dev.db';
}
// Initialize
const fastify = Fastify({
    logger: true,
    trustProxy: true,
});
export const prisma = new PrismaClient();
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
// ============================================
// PLUGINS
// ============================================
await fastify.register(cors, {
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
});
await fastify.register(jwt, {
    secret: process.env.JWT_SECRET || 'your-super-secret-key-change-in-production',
});
await fastify.register(websocket);
// ============================================
// AUTHENTICATION DECORATOR
// ============================================
fastify.decorate('authenticate', async function (request, reply) {
    try {
        await request.jwtVerify();
    }
    catch (err) {
        reply.code(401).send({ error: 'Unauthorized' });
    }
});
// ============================================
// ROUTES
// ============================================
// Health check
fastify.get('/health', async () => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            database: await checkDatabase(),
            redis: await checkRedis(),
        }
    };
});
// Register route modules
await fastify.register(authRoutes, { prefix: '/api/auth' });
await fastify.register(projectRoutes, { prefix: '/api/projects' });
await fastify.register(fileRoutes, { prefix: '/api/files' });
await fastify.register(gitRoutes, { prefix: '/api/git' });
await fastify.register(codeRoutes, { prefix: '/api/code' });
await fastify.register(settingsRoutes, { prefix: '/api/settings' });
await fastify.register(proxyRoutes, { prefix: '/api/proxy' });
await fastify.register(figmaRoutes, { prefix: '/api/figma' });
await fastify.register(aiRoutes, { prefix: '/api/ai' });
// Setup WebSocket
setupWebSocket(fastify);
// ============================================
// HELPERS
// ============================================
async function checkDatabase() {
    try {
        await prisma.$queryRaw `SELECT 1`;
        return 'connected';
    }
    catch {
        return 'disconnected';
    }
}
async function checkRedis() {
    try {
        await redis.ping();
        return 'connected';
    }
    catch {
        return 'disconnected';
    }
}
// ============================================
// START SERVER
// ============================================
const start = async () => {
    try {
        await prisma.$connect();
        console.log('📦 Database connected');
        const port = parseInt(process.env.PORT || '3000');
        const host = process.env.HOST || '0.0.0.0';
        await fastify.listen({ port, host });
        console.log(`🚀 Server running on http://${host}:${port}`);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
// Graceful shutdown
const gracefulShutdown = async () => {
    console.log('Shutting down gracefully...');
    await fastify.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
};
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
start();
