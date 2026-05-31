// ============================================
// AI CODE STUDIO - BULL QUEUE PROCESSOR
// Registers background workers to run ReActAgent loop
// ============================================
import { prisma } from '../index.js';
import { ReActAgent } from './agentReAct.js';
import { activeAgentSockets } from '../websocket/index.js';
import { agentQueue } from './agentQueue.js';
// Register Queue Processor
agentQueue.process('agent-task', async (job) => {
    const { taskId, projectId, goal, config } = job.data;
    console.log(`[Queue] Starting ReAct Agent Task [${taskId}] for goal: "${goal}"`);
    try {
        // Retrieve active WebSocket connection if exists in memory
        const ws = activeAgentSockets.get(taskId) || null;
        // Instantiate real ReAct agent
        const agent = new ReActAgent(goal, projectId, config, taskId, ws);
        // Update task status in DB to running
        await prisma.agentTask.update({
            where: { id: taskId },
            data: { status: 'running' }
        });
        // Run the main ReAct loop
        await agent.run();
        // Clean up active socket from cache map
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
export { agentQueue };
export default agentQueue;
