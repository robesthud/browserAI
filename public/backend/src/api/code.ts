// ============================================
// AI CODE STUDIO - CODE EXECUTION ROUTES
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const CODE_RUNNER_URL = process.env.CODE_RUNNER_URL || 'http://localhost:8000';

export async function codeRoutes(fastify: FastifyInstance) {
  // Run code
  fastify.post('/run', {
    preHandler: [fastify.authenticate],
  }, async (request: any, reply: FastifyReply) => {
    const { language, code, stdin, timeout, memoryLimit } = request.body as {
      language: string;
      code: string;
      stdin?: string;
      timeout?: number;
      memoryLimit?: number;
    };

    try {
      const response = await fetch(`${CODE_RUNNER_URL}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          code,
          stdin: stdin || '',
          timeout: timeout || 10,
          memory_limit: memoryLimit || 256,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        return reply.code(response.status).send({ error: error.detail || 'Code execution failed' });
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Code runner error:', error);
      return reply.code(503).send({ error: 'Code runner service unavailable' });
    }
  });

  // Get supported languages
  fastify.get('/languages', async () => {
    try {
      const response = await fetch(`${CODE_RUNNER_URL}/languages`);
      return response.json();
    } catch {
      // Return default languages if service is unavailable
      return {
        languages: ['python', 'javascript', 'typescript', 'go', 'rust'],
      };
    }
  });

  // Check code runner health
  fastify.get('/health', async () => {
    try {
      const response = await fetch(`${CODE_RUNNER_URL}/health`);
      return response.json();
    } catch {
      return { status: 'unavailable' };
    }
  });
}
