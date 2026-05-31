// ============================================
// AI CODE STUDIO - PROJECT ROUTES
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../index.js';
import { randomUUID } from 'crypto';

export async function projectRoutes(fastify: FastifyInstance) {
  // List all projects
  fastify.get('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const projects = await prisma.project.findMany({
      where: { ownerId: request.user.userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { files: true } },
        gitRepo: true,
      },
    });

    return { projects };
  });

  // Get single project with files
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    const project = await prisma.project.findFirst({
      where: {
        id,
        ownerId: request.user.userId,
      },
      include: {
        files: {
          orderBy: { path: 'asc' },
        },
        gitRepo: true,
      },
    });

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    return { project };
  });

  // Create new project
  fastify.post('/', {
    preHandler: [fastify.authenticate],
  }, async (request: any) => {
    const { name, description, template } = request.body as {
      name: string;
      description?: string;
      template?: string;
    };

    const project = await prisma.project.create({
      data: {
        id: randomUUID(),
        name,
        description,
        ownerId: request.user.userId,
      },
    });

    // Create initial files based on template
    if (template) {
      const files = getTemplateFiles(template, project.id);
      for (const file of files) {
        await prisma.file.create({ data: file });
      }
    }

    return { project };
  });

  // Update project
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;
    const { name, description } = request.body as {
      name?: string;
      description?: string;
    };

    // Check ownership
    const existing = await prisma.project.findFirst({
      where: { id, ownerId: request.user.userId },
    });

    if (!existing) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const project = await prisma.project.update({
      where: { id },
      data: { name, description, updatedAt: new Date() },
    });

    return { project };
  });

  // Delete project
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    // Check ownership
    const existing = await prisma.project.findFirst({
      where: { id, ownerId: request.user.userId },
    });

    if (!existing) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Delete files first
    await prisma.file.deleteMany({ where: { projectId: id } });
    
    // Delete git repo if exists
    await prisma.gitRepo.deleteMany({ where: { projectId: id } });
    
    // Delete project
    await prisma.project.delete({ where: { id } });

    return { success: true };
  });

  // Get project files
  fastify.get('/:id/files', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { id } = request.params;

    // Check ownership
    const project = await prisma.project.findFirst({
      where: { id, ownerId: request.user.userId },
    });

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const files = await prisma.file.findMany({
      where: { projectId: id },
      orderBy: { path: 'asc' },
    });

    // Build tree structure
    const tree = buildFileTree(files);

    return { files: tree };
  });
}

// ============================================
// HELPERS
// ============================================

function getTemplateFiles(template: string, projectId: string): any[] {
  const templates: Record<string, any[]> = {
    react: [
      { id: randomUUID(), projectId, path: 'src/App.tsx', name: 'App.tsx', type: 'file', content: `import React from 'react';\n\nexport default function App() {\n  return <div>Hello World</div>;\n}` },
      { id: randomUUID(), projectId, path: 'src/main.tsx', name: 'main.tsx', type: 'file', content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);` },
      { id: randomUUID(), projectId, path: 'package.json', name: 'package.json', type: 'file', content: JSON.stringify({ name: 'react-app', dependencies: { react: '^18', 'react-dom': '^18' } }, null, 2) },
    ],
    node: [
      { id: randomUUID(), projectId, path: 'src/index.ts', name: 'index.ts', type: 'file', content: `console.log('Hello from Node.js!');` },
      { id: randomUUID(), projectId, path: 'package.json', name: 'package.json', type: 'file', content: JSON.stringify({ name: 'node-app', type: 'module', scripts: { start: 'node src/index.ts' } }, null, 2) },
    ],
    python: [
      { id: randomUUID(), projectId, path: 'main.py', name: 'main.py', type: 'file', content: `def main():\n    print("Hello from Python!")\n\nif __name__ == "__main__":\n    main()` },
      { id: randomUUID(), projectId, path: 'requirements.txt', name: 'requirements.txt', type: 'file', content: '' },
    ],
  };

  return templates[template] || [];
}

function buildFileTree(files: any[]): any[] {
  const tree: any[] = [];
  const dirs: Record<string, any> = {};

  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.pop()!;
    
    if (parts.length === 0) {
      // Root level file
      tree.push({ ...file, name, children: file.type === 'folder' ? [] : undefined });
    } else {
      // Nested file - create parent directories
      let parent = tree;
      let currentPath = '';
      
      for (const part of parts) {
        currentPath += (currentPath ? '/' : '') + part;
        
        if (!dirs[currentPath]) {
          const dir = {
            id: currentPath,
            name: part,
            path: currentPath,
            type: 'folder',
            children: [],
          };
          parent.push(dir);
          dirs[currentPath] = dir;
        }
        
        parent = dirs[currentPath].children;
      }
      
      parent.push({ ...file, name });
    }
  }

  return tree;
}
