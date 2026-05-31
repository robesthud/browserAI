// ============================================
// AI CODE STUDIO - AGENT QUEUE (BULL)
// Exports the Bull queue for background agent tasks
// ============================================

import Queue from 'bull';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const agentQueue = new Queue('agent-tasks', REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
  },
});

console.log('🐂 Bull agentQueue initialized with Redis:', REDIS_URL);
export default agentQueue;
