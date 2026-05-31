// ============================================
// AI CODE STUDIO - AGENT TOOLS IMPLEMENTATION
// Executes actions for the ReAct Agent with retries and microservice bindings
// ============================================
import { prisma } from '../index.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { CodeRunnerClient } from './code-runner-client.js';
import { BrowserAgentService } from './browser-agent-service.js';
const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
/**
 * Helper to retry transient service failures (max 3 attempts)
 */
async function retry(fn, retries = 3, delay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastError = err;
            console.warn(`[Agent Tool Retry] Attempt ${attempt} failed: ${String(err)}`);
            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, delay * attempt));
            }
        }
    }
    throw lastError;
}
export class AgentTools {
    /**
     * Read file from DB or local directory
     */
    static async read_file(projectId, path) {
        return retry(async () => {
            try {
                const file = await prisma.file.findFirst({
                    where: { projectId, path },
                });
                if (file && file.content !== null) {
                    return file.content;
                }
                // Local filesystem fallback
                const projectPath = join(PROJECTS_DIR, projectId, path);
                return await readFile(projectPath, 'utf-8');
            }
            catch (error) {
                throw new Error(`Failed to read file ${path}: ${String(error)}`);
            }
        });
    }
    /**
     * Write file to DB and local directory
     */
    static async write_file(projectId, path, content) {
        return retry(async () => {
            try {
                const projectPath = join(PROJECTS_DIR, projectId);
                const filePath = join(projectPath, path);
                await mkdir(join(filePath, '..'), { recursive: true });
                await writeFile(filePath, content, 'utf-8');
                const name = path.split('/').pop() || 'file';
                await prisma.file.upsert({
                    where: {
                        projectId_path: { projectId, path }
                    },
                    update: {
                        content,
                        updatedAt: new Date(),
                    },
                    create: {
                        id: randomUUID(),
                        projectId,
                        path,
                        name,
                        type: 'FILE',
                        content,
                    }
                });
                return `Successfully wrote to file: ${path}`;
            }
            catch (error) {
                throw new Error(`Failed to write file ${path}: ${String(error)}`);
            }
        });
    }
    /**
     * Edit/Replace specific text block inside a file
     */
    static async edit_file(projectId, path, search, replace) {
        return retry(async () => {
            try {
                const currentContent = await this.read_file(projectId, path);
                if (!currentContent.includes(search)) {
                    throw new Error(`Could not find search block inside ${path}`);
                }
                const newContent = currentContent.replace(search, replace);
                await this.write_file(projectId, path, newContent);
                return `Successfully edited file: ${path}`;
            }
            catch (error) {
                throw new Error(`Failed to edit file ${path}: ${String(error)}`);
            }
        });
    }
    /**
     * List files in project directory
     */
    static async list_dir(projectId, path) {
        return retry(async () => {
            try {
                const projectPath = join(PROJECTS_DIR, projectId, path);
                const entries = await readdir(projectPath, { withFileTypes: true });
                return entries.map(entry => entry.name);
            }
            catch (error) {
                const files = await prisma.file.findMany({
                    where: {
                        projectId,
                        path: { startsWith: path ? path + '/' : '' }
                    }
                });
                if (files.length === 0)
                    return [];
                return Array.from(new Set(files.map(f => f.name)));
            }
        });
    }
    /**
     * Run terminal command inside the project directory via microservice CODE_RUNNER_URL
     */
    static async run_command(projectId, command, cwd = '') {
        return retry(async () => {
            try {
                // Force compile or execute in isolated container via CodeRunnerClient
                const response = await CodeRunnerClient.run('bash', command, '', 15, 256);
                return response.stdout || response.stderr || 'Command executed with zero output.';
            }
            catch (error) {
                throw new Error(`Command execution failed via Code Runner: ${error.message}`);
            }
        });
    }
    /**
     * Install npm or pip package via Code Runner
     */
    static async install_package(projectId, pkg, manager) {
        const cmd = manager === 'npm' ? `npm install ${pkg}` : `pip install ${pkg}`;
        return this.run_command(projectId, cmd);
    }
    /**
     * Browser actions delegating to BROWSER_AGENT_URL /api/browser/agent endpoint
     */
    static async browser_navigate(url, sessionId = 'default') {
        return retry(async () => {
            return BrowserAgentService.executeAgentInstruction('go to ' + url, undefined, sessionId);
        });
    }
    static async browser_click(selector, sessionId = 'default') {
        return retry(async () => {
            return BrowserAgentService.executeAgentInstruction('click ' + selector, undefined, sessionId);
        });
    }
    static async browser_type(selector, text, sessionId = 'default') {
        return retry(async () => {
            return BrowserAgentService.executeAgentInstruction(`type "${text}" into ${selector}`, undefined, sessionId);
        });
    }
    static async browser_extract(selector, sessionId = 'default') {
        return retry(async () => {
            return BrowserAgentService.executeAgentInstruction('extract ' + selector, undefined, sessionId);
        });
    }
    static async search_web(query, sessionId = 'default') {
        return retry(async () => {
            return BrowserAgentService.executeAgentInstruction('search for ' + query, undefined, sessionId);
        });
    }
}
