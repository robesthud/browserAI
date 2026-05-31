// ============================================
// AI CODE STUDIO - FILE ROUTES
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../index.js';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { S3StorageService } from '../services/s3.js';

export async function fileRoutes(fastify: FastifyInstance) {
  // Get file content
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    const file = await prisma.file.findFirst({
      where: { id },
      include: {
        project: {
          select: { ownerId: true },
        },
      },
    });

    if (!file || file.project.ownerId !== request.user.userId) {
      return reply.code(404).send({ error: 'File not found' });
    }

    // If content is saved in S3, read it
    if (file.blobUrl) {
      try {
        const buffer = await S3StorageService.read(file.id);
        file.content = buffer.toString('utf-8');
      } catch (err) {
        console.error('Failed to read file from S3:', err);
      }
    }

    return { file };
  });

  // Create file
  fastify.post('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { projectId, path, name, type, content } = request.body as {
      projectId: string;
      path: string;
      name: string;
      type: 'file' | 'folder';
      content?: string;
    };

    // Check project ownership
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: request.user.userId },
    });

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Check if file already exists
    const existing = await prisma.file.findFirst({
      where: { projectId, path },
    });

    if (existing) {
      return reply.code(409).send({ error: 'File already exists' });
    }

    const fileId = randomUUID();
    const hash = content ? createHash('sha256').update(content).digest('hex') : null;

    let blobUrl: string | null = null;
    let savedContent: string | null = content || null;

    // S3 upload if file > 1MB
    if (content && content.length > 1000000) {
      try {
        blobUrl = await S3StorageService.upload(fileId, content, 'text/plain');
        savedContent = null; // Don't save large content in Database
      } catch (err) {
        console.error('S3 upload fallback error:', err);
      }
    }

    const file = await prisma.file.create({
      data: {
        id: fileId,
        projectId,
        path,
        name,
        type,
        content: savedContent,
        blobUrl,
        hash,
      },
    });

    // Update project timestamp
    await prisma.project.update({
      where: { id: projectId },
      data: { updatedAt: new Date() },
    });

    return { file };
  });

  // Update file content
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;
    const { content } = request.body as { content: string };

    // Check file ownership
    const file = await prisma.file.findFirst({
      where: { id },
      include: {
        project: { select: { ownerId: true } },
      },
    });

    if (!file || file.project.ownerId !== request.user.userId) {
      return reply.code(404).send({ error: 'File not found' });
    }

    // Save current version to history (read from S3 if needed)
    let historyContent = file.content;
    if (file.blobUrl && !historyContent) {
      try {
        const buffer = await S3StorageService.read(id);
        historyContent = buffer.toString('utf-8');
      } catch {}
    }

    if (historyContent) {
      await prisma.fileVersion.create({
        data: {
          id: randomUUID(),
          fileId: id,
          content: historyContent,
          hash: file.hash || '',
        },
      });
    }

    const hash = createHash('sha256').update(content).digest('hex');

    let blobUrl: string | null = null;
    let savedContent: string | null = content;

    // S3 upload if file > 1MB
    if (content.length > 1000000) {
      try {
        blobUrl = await S3StorageService.upload(id, content, 'text/plain');
        savedContent = null;
      } catch (err) {
        console.error('S3 update upload error:', err);
      }
    } else if (file.blobUrl) {
      // If it was in S3 but is now small, remove from S3
      await S3StorageService.delete(id);
    }

    const updated = await prisma.file.update({
      where: { id },
      data: {
        content: savedContent,
        blobUrl,
        hash,
        updatedAt: new Date(),
      },
    });

    // Update project timestamp
    await prisma.project.update({
      where: { id: file.projectId },
      data: { updatedAt: new Date() },
    });

    return { file: updated };
  });

  // Rename file
  fastify.post('/:id/rename', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;
    const { newPath, newName } = request.body as {
      newPath: string;
      newName: string;
    };

    // Check file ownership
    const file = await prisma.file.findFirst({
      where: { id },
      include: {
        project: { select: { ownerId: true } },
      },
    });

    if (!file || file.project.ownerId !== request.user.userId) {
      return reply.code(404).send({ error: 'File not found' });
    }

    // Check if target path already exists
    const existing = await prisma.file.findFirst({
      where: {
        projectId: file.projectId,
        path: newPath,
        id: { not: id },
      },
    });

    if (existing) {
      return reply.code(409).send({ error: 'Target path already exists' });
    }

    const updated = await prisma.file.update({
      where: { id },
      data: {
        path: newPath,
        name: newName,
        updatedAt: new Date(),
      },
    });

    return { file: updated };
  });

  // Delete file
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    // Check file ownership
    const file = await prisma.file.findFirst({
      where: { id },
      include: {
        project: { select: { ownerId: true } },
      },
    });

    if (!file || file.project.ownerId !== request.user.userId) {
      return reply.code(404).send({ error: 'File not found' });
    }

    // Delete file versions
    await prisma.fileVersion.deleteMany({ where: { fileId: id } });

    // If folder, delete all children
    if (file.type === 'folder') {
      await prisma.file.deleteMany({
        where: {
          projectId: file.projectId,
          path: { startsWith: file.path + '/' },
        },
      });
    }

    // Delete file
    await prisma.file.delete({ where: { id } });

    return { success: true };
  });

  // Get file history
  fastify.get('/:id/history', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    // Check file ownership
    const file = await prisma.file.findFirst({
      where: { id },
      include: {
        project: { select: { ownerId: true } },
      },
    });

    if (!file || file.project.ownerId !== request.user.userId) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const versions = await prisma.fileVersion.findMany({
      where: { fileId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { versions };
  });
}
