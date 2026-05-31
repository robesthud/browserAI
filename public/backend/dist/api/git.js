// ============================================
// AI CODE STUDIO - GIT ROUTES
// ============================================
import { prisma } from '../index.js';
import simpleGit from 'simple-git';
import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
function getGit(projectPath) {
    const sg = simpleGit;
    if (typeof sg === 'function')
        return sg(projectPath);
    if (sg.simpleGit && typeof sg.simpleGit === 'function')
        return sg.simpleGit(projectPath);
    if (sg.default && typeof sg.default === 'function')
        return sg.default(projectPath);
    return sg;
}
export async function gitRoutes(fastify) {
    // Clone repository
    fastify.post('/clone', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { url, branch, name } = request.body;
        try {
            // Create project
            const projectName = name || url.split('/').pop()?.replace('.git', '') || 'cloned-repo';
            const projectId = randomUUID();
            const project = await prisma.project.create({
                data: {
                    id: projectId,
                    name: projectName,
                    ownerId: request.user.userId,
                },
            });
            // Clone repository
            const projectPath = join(PROJECTS_DIR, projectId);
            await mkdir(projectPath, { recursive: true });
            const git = getGit(projectPath);
            await git.clone(url, '.', branch ? ['--branch', branch] : []);
            // Get default branch
            const branchName = branch || (await git.branch()).current || 'main';
            // Create git repo record
            await prisma.gitRepo.create({
                data: {
                    id: randomUUID(),
                    projectId,
                    remoteUrl: url,
                    branch: branchName,
                    lastSync: new Date(),
                },
            });
            // Index files
            await indexProjectFiles(projectId, projectPath);
            return { project };
        }
        catch (error) {
            console.error('Clone error:', error);
            return reply.code(500).send({ error: 'Failed to clone repository' });
        }
    });
    // Create commit
    fastify.post('/commit', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId, message, files } = request.body;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
            include: { gitRepo: true },
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        if (!project.gitRepo) {
            return reply.code(400).send({ error: 'Project is not a git repository' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            // Write files if provided
            if (files && files.length > 0) {
                for (const file of files) {
                    await writeFile(join(projectPath, file.path), file.content);
                }
            }
            // Stage and commit
            await git.add('.');
            const commit = await git.commit(message);
            return { commit };
        }
        catch (error) {
            console.error('Commit error:', error);
            return reply.code(500).send({ error: 'Failed to create commit' });
        }
    });
    // Push changes
    fastify.post('/push', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId } = request.body;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
            include: { gitRepo: true },
        });
        if (!project?.gitRepo) {
            return reply.code(404).send({ error: 'Git repository not found' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            await git.push('origin', project.gitRepo.branch);
            // Update last sync
            await prisma.gitRepo.update({
                where: { id: project.gitRepo.id },
                data: { lastSync: new Date() },
            });
            return { success: true };
        }
        catch (error) {
            console.error('Push error:', error);
            return reply.code(500).send({ error: 'Failed to push changes' });
        }
    });
    // Pull changes
    fastify.post('/pull', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId } = request.body;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
            include: { gitRepo: true },
        });
        if (!project?.gitRepo) {
            return reply.code(404).send({ error: 'Git repository not found' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            await git.pull('origin', project.gitRepo.branch);
            // Re-index files
            await indexProjectFiles(projectId, projectPath);
            // Update last sync
            await prisma.gitRepo.update({
                where: { id: project.gitRepo.id },
                data: { lastSync: new Date() },
            });
            return { success: true };
        }
        catch (error) {
            console.error('Pull error:', error);
            return reply.code(500).send({ error: 'Failed to pull changes' });
        }
    });
    // Get commit log
    fastify.get('/log', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId, limit = 50 } = request.query;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            const log = await git.log({ maxCount: limit });
            return {
                commits: log.all.map(commit => ({
                    hash: commit.hash,
                    message: commit.message,
                    author: commit.author_name,
                    email: commit.author_email,
                    date: commit.date,
                })),
            };
        }
        catch (error) {
            console.error('Log error:', error);
            return reply.code(500).send({ error: 'Failed to get commit log' });
        }
    });
    // Get branches
    fastify.get('/branches', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId } = request.query;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            const branches = await git.branch();
            return {
                current: branches.current,
                branches: branches.all,
            };
        }
        catch (error) {
            console.error('Branches error:', error);
            return reply.code(500).send({ error: 'Failed to get branches' });
        }
    });
    // Switch branch
    fastify.post('/branch', {
        preHandler: [fastify.authenticate],
    }, async (request, reply) => {
        const { projectId, branch, create } = request.body;
        // Check project ownership
        const project = await prisma.project.findFirst({
            where: { id: projectId, ownerId: request.user.userId },
            include: { gitRepo: true },
        });
        if (!project?.gitRepo) {
            return reply.code(404).send({ error: 'Git repository not found' });
        }
        try {
            const projectPath = join(PROJECTS_DIR, projectId);
            const git = getGit(projectPath);
            if (create) {
                await git.checkoutBranch(branch, 'HEAD');
            }
            else {
                await git.checkout(branch);
            }
            // Update git repo record
            await prisma.gitRepo.update({
                where: { id: project.gitRepo.id },
                data: { branch },
            });
            return { success: true, branch };
        }
        catch (error) {
            console.error('Branch error:', error);
            return reply.code(500).send({ error: 'Failed to switch branch' });
        }
    });
}
// ============================================
// HELPERS
// ============================================
async function indexProjectFiles(projectId, projectPath) {
    // Delete existing files
    await prisma.file.deleteMany({ where: { projectId } });
    // Read and index all files
    await indexDirectory(projectId, projectPath, '');
}
async function indexDirectory(projectId, basePath, relativePath) {
    const fullPath = relativePath ? join(basePath, relativePath) : basePath;
    const entries = await readdir(fullPath, { withFileTypes: true });
    for (const entry of entries) {
        // Skip .git directory
        if (entry.name === '.git')
            continue;
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await prisma.file.create({
                data: {
                    id: randomUUID(),
                    projectId,
                    path: entryPath,
                    name: entry.name,
                    type: 'folder',
                },
            });
            await indexDirectory(projectId, basePath, entryPath);
        }
        else {
            // Read file content (limit to 1MB)
            let content = null;
            const filePath = join(basePath, entryPath);
            try {
                const stats = await (await import('fs')).promises.stat(filePath);
                if (stats.size < 1024 * 1024) {
                    content = await readFile(filePath, 'utf-8');
                }
            }
            catch { }
            await prisma.file.create({
                data: {
                    id: randomUUID(),
                    projectId,
                    path: entryPath,
                    name: entry.name,
                    type: 'file',
                    content,
                },
            });
        }
    }
}
