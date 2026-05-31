// ============================================
// AI CODE STUDIO - AUTH ROUTES
// ============================================
import bcrypt from 'bcryptjs';
import { prisma } from '../index.js';
export async function authRoutes(fastify) {
    // Register
    fastify.post('/register', async (request, reply) => {
        const { email, password, name } = request.body;
        // Validate input
        if (!email || !password || !name) {
            return reply.code(400).send({ error: 'Missing required fields' });
        }
        // Check if user exists
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            return reply.code(409).send({ error: 'User already exists' });
        }
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);
        // Create user
        const user = await prisma.user.create({
            data: {
                email,
                name,
                password: hashedPassword,
            },
            select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                createdAt: true,
            },
        });
        // Generate token
        const token = fastify.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
        return { token, user };
    });
    // Login
    fastify.post('/login', async (request, reply) => {
        const { email, password } = request.body;
        // Find user
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.password) {
            return reply.code(401).send({ error: 'Invalid credentials' });
        }
        // Verify password
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return reply.code(401).send({ error: 'Invalid credentials' });
        }
        // Generate token
        const token = fastify.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
        return {
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                avatar: user.avatar,
            },
        };
    });
    // GitHub OAuth
    fastify.post('/github', async (request, reply) => {
        const { code } = request.body;
        if (!code) {
            return reply.code(400).send({ error: 'Missing code' });
        }
        try {
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
            if (!access_token) {
                return reply.code(400).send({ error: 'Failed to get access token' });
            }
            // Get user info from GitHub
            const userResponse = await fetch('https://api.github.com/user', {
                headers: { Authorization: `Bearer ${access_token}` },
            });
            const githubUser = await userResponse.json();
            // Get primary email
            const emailsResponse = await fetch('https://api.github.com/user/emails', {
                headers: { Authorization: `Bearer ${access_token}` },
            });
            const emails = await emailsResponse.json();
            const primaryEmail = emails.find((e) => e.primary)?.email || githubUser.email;
            // Upsert user
            const user = await prisma.user.upsert({
                where: { githubId: String(githubUser.id) },
                update: {
                    name: githubUser.name || githubUser.login,
                    avatar: githubUser.avatar_url,
                },
                create: {
                    githubId: String(githubUser.id),
                    email: primaryEmail || `${githubUser.id}@github.local`,
                    name: githubUser.name || githubUser.login,
                    avatar: githubUser.avatar_url,
                },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    avatar: true,
                },
            });
            // Generate JWT
            const token = fastify.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
            return { token, user };
        }
        catch (error) {
            console.error('GitHub OAuth error:', error);
            return reply.code(500).send({ error: 'OAuth failed' });
        }
    });
    // Google OAuth / Token Login
    fastify.post('/google', async (request, reply) => {
        const { token, code } = request.body;
        if (!token && !code) {
            return reply.code(400).send({ error: 'Missing token or authorization code' });
        }
        try {
            let googleUser = null;
            if (token) {
                // 1. Verify Google ID Token via Google API
                const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
                if (!verifyResponse.ok) {
                    return reply.code(400).send({ error: 'Invalid Google ID Token' });
                }
                const tokenInfo = await verifyResponse.json();
                googleUser = {
                    id: tokenInfo.sub,
                    email: tokenInfo.email,
                    name: tokenInfo.name || tokenInfo.given_name,
                    picture: tokenInfo.picture,
                };
            }
            else if (code) {
                // 2. Exchange authorization code for access token
                const exchangeResponse = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        code,
                        client_id: process.env.GOOGLE_CLIENT_ID,
                        client_secret: process.env.GOOGLE_CLIENT_SECRET,
                        redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'postmessage',
                        grant_type: 'authorization_code',
                    }),
                });
                if (!exchangeResponse.ok) {
                    const errText = await exchangeResponse.text();
                    return reply.code(400).send({ error: `Google Auth exchange failed: ${errText}` });
                }
                const exchangeData = await exchangeResponse.json();
                const accessToken = exchangeData.access_token;
                // Fetch user profile info
                const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                const profileData = await profileResponse.json();
                googleUser = {
                    id: profileData.id,
                    email: profileData.email,
                    name: profileData.name || profileData.given_name,
                    picture: profileData.picture,
                };
            }
            if (!googleUser || !googleUser.email) {
                return reply.code(400).send({ error: 'Failed to retrieve Google user profile' });
            }
            // Upsert Google User into database
            const user = await prisma.user.upsert({
                where: { email: googleUser.email },
                update: {
                    name: googleUser.name,
                    avatar: googleUser.picture,
                },
                create: {
                    email: googleUser.email,
                    name: googleUser.name,
                    avatar: googleUser.picture,
                },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    avatar: true,
                },
            });
            // Generate JWT
            const jwtToken = fastify.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
            return { token: jwtToken, user };
        }
        catch (error) {
            console.error('Google OAuth error:', error);
            return reply.code(500).send({ error: 'Google authentication failed' });
        }
    });
    // Get current user
    fastify.get('/me', {
        preHandler: [fastify.authenticate],
    }, async (request) => {
        const user = await prisma.user.findUnique({
            where: { id: request.user.userId },
            select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                settings: true,
                createdAt: true,
            },
        });
        if (!user) {
            return { error: 'User not found' };
        }
        return { user };
    });
    // Refresh token
    fastify.post('/refresh', {
        preHandler: [fastify.authenticate],
    }, async (request) => {
        const token = fastify.jwt.sign({ userId: request.user.userId }, { expiresIn: '7d' });
        return { token };
    });
    // Logout (client-side, but we can invalidate refresh tokens if needed)
    fastify.post('/logout', async () => {
        return { success: true };
    });
}
