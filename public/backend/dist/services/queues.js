// ============================================
// AI CODE STUDIO - BULL QUEUE MANAGEMENT (REDIS)
// Handles background execution of ИИ-Агент tasks using ReActAgent loop
// ============================================
import Queue from 'bull';
import { prisma } from '../index.js';
import { ReActAgent } from './agentReAct.js';
import { activeAgentSockets } from '../websocket/index.js';
// Initialize Bull Queue
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const agentQueue = new Queue('agent-tasks', REDIS_URL);
console.log('🐂 Bull Queue initialized with Redis');
// Register Queue Processor
agentQueue.process('agent-task', async (job) => {
    const { taskId, projectId, goal, config } = job.data;
    console.log(`[Queue] Starting ReAct Agent Task [${taskId}] for goal: "${goal}"`);
    try {
        // Fetch active socket to pass to ReActAgent
        const ws = activeAgentSockets.get(taskId) || null;
        // Instantiate real ReAct agent
        const agent = new ReActAgent(goal, projectId, config, taskId, ws);
        // Update task status in DB to running
        await prisma.agentTask.update({
            where: { id: taskId },
            data: { status: 'running' }
        });
        // Run the main reasoning loop
        await agent.run();
        // Clean up mapped socket after completion
        activeAgentSockets.delete(taskId);
        console.log(`[Queue] Finished ReAct Agent Task [${taskId}]`);
    }
    catch (error) {
        console.error(`[Queue] Error running ReAct agent task [${taskId}]:`, error);
        await prisma.agentTask.update({
            where: { id: taskId },
            data: { status: 'failed' }
        });
        activeAgentSockets.delete(taskId);
    }
});
