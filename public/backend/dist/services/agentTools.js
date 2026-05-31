// ============================================
// AI CODE STUDIO - AGENT TOOLS IMPLEMENTATION
// Executes real actions for the ReAct Agent Loop
// ============================================
import { prisma } from '../index.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserAgentService } from './browser-agent-service.js';
const execAsync = promisify(exec);
const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
export class AgentTools {
    /**
     * Read file from DB or local directory
     */
    static async read_file(projectId, path) {
        try {
            const file = await prisma.file.findFirst({
                where: { projectId, path },
            });
            if (file && file.content !== null) {
                return file.content;
            }
            // Try local filesystem fallback
            const projectPath = join(PROJECTS_DIR, projectId, path);
            return await readFile(projectPath, 'utf-8');
        }
        catch (error) {
            throw new Error(`Failed to read file ${path}: ${String(error)}`);
        }
    }
    /**
     * Write file to DB and local directory
     */
    static async write_file(projectId, path, content) {
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
    }
    /**
     * Edit/Replace specific text block inside a file
     */
    static async edit_file(projectId, path, search, replace) {
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
    }
    /**
     * List files in project directory
     */
    static async list_dir(projectId, path) {
        try {
            const projectPath = join(PROJECTS_DIR, projectId, path);
            const entries = await readdir(projectPath, { withFileTypes: true });
            return entries.map(entry => entry.name);
        }
        catch (error) {
            // If folder not found locally, fetch from DB
            const files = await prisma.file.findMany({
                where: {
                    projectId,
                    path: { startsWith: path ? path + '/' : '' }
                }
            });
            if (files.length === 0) {
                return [];
            }
            return Array.from(new Set(files.map(f => f.name)));
        }
    }
    /**
     * Run terminal command inside the project directory
     */
    static async run_command(projectId, command, cwd = '') {
        try {
            // Try running via FastAPI Code Runner first
            const activeCwd = join(PROJECTS_DIR, projectId, cwd);
            await mkdir(activeCwd, { recursive: true });
            // Run natively in sandbox
            const { stdout, stderr } = await execAsync(command, { cwd: activeCwd });
            return stdout || stderr || 'Command completed successfully with no output.';
        }
        catch (error) {
            throw new Error(`Command execution failed: ${error.stderr || error.message}`);
        }
    }
    /**
     * Install npm or pip package
     */
    static async install_package(projectId, pkg, manager) {
        const cmd = manager === 'npm' ? `npm install ${pkg}` : `pip install ${pkg}`;
        return this.run_command(projectId, cmd);
    }
    /**
     * Browser actions delegating to BrowserAgent Playwright service
     */
    static async browser_navigate(url) {
        return BrowserAgentService.executeAgentInstruction('go to ' + url);
    }
    static async browser_click(selector) {
        return BrowserAgentService.executeAgentInstruction('click ' + selector);
    }
    static async browser_type(selector, text) {
        return BrowserAgentService.executeAgentInstruction(`type "${text}" into ${selector}`);
    }
    static async browser_extract(selector) {
        return BrowserAgentService.executeAgentInstruction('extract ' + selector);
    }
    static async search_web(query) {
        return BrowserAgentService.executeAgentInstruction('search for ' + query);
    }
}
