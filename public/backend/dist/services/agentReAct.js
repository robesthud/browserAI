// ============================================
// AI CODE STUDIO - REACT AGENT IMPLEMENTATION
// Handles the ReAct Loop (Reasoning + Acting)
// ============================================
import { AIAdapter } from './aiAdapter.js';
import { prisma } from '../index.js';
import { randomUUID } from 'crypto';
import { AgentTools } from './agentTools.js';
import { WebSocket } from 'ws';
export class ReActAgent {
    goal;
    projectId;
    config;
    taskId;
    ws = null;
    stepCount = 0;
    maxSteps = 30;
    constructor(goal, projectId, config, taskId, ws = null) {
        this.goal = goal;
        this.projectId = projectId;
        this.config = config;
        this.taskId = taskId;
        this.ws = ws;
    }
    /**
     * Broadcast message to the websocket client
     */
    sendClientUpdate(type, payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, payload }));
        }
    }
    /**
     * Main Execution Loop
     */
    async run() {
        console.log(`[ReAct Agent] Running loop for task [${this.taskId}]...`);
        this.sendClientUpdate('agent:running', { taskId: this.taskId, goal: this.goal });
        // Initial system history
        const messageHistory = [
            {
                role: 'system',
                content: `Ты — AI Agent, помогающий разрабатывать ПО. Твоя задача — выполнить goal пользователя.
        
        Доступные инструменты:
        - read_file(path) — прочитать файл
        - write_file(path, content) — создать/перезаписать файл
        - edit_file(path, search, replace) — отредактировать файл (первое вхождение)
        - list_dir(path) — список файлов в директории
        - run_command(command) — выполнить команду терминала
        - install_package(package, manager) — установить пакет
        - browser_navigate(url) — открыть URL
        - browser_click(selector) — кликнуть на селектор
        - browser_type(selector, text) — ввести текст в поле
        - browser_extract(selector) — извлечь данные с веб-страницы
        - search_web(query) — поискать в интернете
        - complete(result) — завершить задачу с результатом

        Каждый твой ответ должен быть СТРОГИМ JSON с полями: thought, action, action_input. Не пиши никакой другой текст.
        Формат:
        {
          "thought": "Твои размышления",
          "action": "имя_инструмента",
          "action_input": {
            "параметр": "значение"
          }
        }
        `
            },
            {
                role: 'user',
                content: `Goal: "${this.goal}"`
            }
        ];
        while (this.stepCount < this.maxSteps) {
            this.stepCount++;
            console.log(`[ReAct Agent] Step ${this.stepCount}/${this.maxSteps}`);
            // 1. Think (Call LLM)
            let decision;
            try {
                decision = await this.think(messageHistory);
            }
            catch (err) {
                console.error('[ReAct Agent] Thinking failed:', err);
                await this.saveAndObserve('error', `Thinking failed: ${err.message}`);
                break;
            }
            // 2. Save Thought & Action to DB/Client
            await this.saveAndObserve('thought', decision.thought);
            if (decision.action === 'complete') {
                const result = decision.action_input?.result || 'Task completed successfully.';
                await this.saveAndObserve('complete', result);
                this.sendClientUpdate('agent:complete', { taskId: this.taskId, result });
                break;
            }
            // 3. Act (Execute tool)
            let observation = '';
            try {
                observation = await this.act(decision.action, decision.action_input);
            }
            catch (err) {
                observation = `Error executing ${decision.action}: ${err.message}`;
            }
            // 4. Observe
            await this.saveAndObserve('observation', observation);
            // Append step output to LLM history context
            messageHistory.push({
                role: 'assistant',
                content: JSON.stringify(decision)
            });
            messageHistory.push({
                role: 'user',
                content: `Observation: ${observation}`
            });
        }
        if (this.stepCount >= this.maxSteps) {
            const errorMsg = 'Task terminated due to exceeding max steps limit.';
            await this.saveAndObserve('error', errorMsg);
            this.sendClientUpdate('agent:error', { taskId: this.taskId, error: errorMsg });
        }
    }
    /**
     * Prompts LLM for next step decision
     */
    async think(history) {
        const rawResponse = await AIAdapter.chat(this.config, history);
        try {
            const cleanJSON = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanJSON);
        }
        catch {
            throw new Error(`Failed to parse structured output from LLM: ${rawResponse}`);
        }
    }
    /**
     * Executes the mapped action tool
     */
    async act(action, input) {
        this.sendClientUpdate('agent:step', { taskId: this.taskId, action, input });
        switch (action) {
            case 'read_file':
                return await AgentTools.read_file(this.projectId, input.path);
            case 'write_file':
                return await AgentTools.write_file(this.projectId, input.path, input.content);
            case 'edit_file':
                return await AgentTools.edit_file(this.projectId, input.path, input.search, input.replace);
            case 'list_dir':
                const dirContent = await AgentTools.list_dir(this.projectId, input.path || '');
                return JSON.stringify(dirContent);
            case 'run_command':
                return await AgentTools.run_command(this.projectId, input.command, input.cwd);
            case 'install_package':
                return await AgentTools.install_package(this.projectId, input.package, input.manager);
            case 'browser_navigate':
                return JSON.stringify(await AgentTools.browser_navigate(input.url));
            case 'browser_click':
                return JSON.stringify(await AgentTools.browser_click(input.selector));
            case 'browser_type':
                return JSON.stringify(await AgentTools.browser_type(input.selector, input.text));
            case 'browser_extract':
                return JSON.stringify(await AgentTools.browser_extract(input.selector));
            case 'search_web':
                return JSON.stringify(await AgentTools.search_web(input.query));
            default:
                throw new Error(`Unknown tool action: ${action}`);
        }
    }
    /**
     * Logs steps and outputs to Prisma and WebSockets
     */
    async saveAndObserve(type, content) {
        const isError = type === 'error';
        const status = isError ? 'error' : 'completed';
        await prisma.agentStep.create({
            data: {
                id: randomUUID(),
                taskId: this.taskId,
                type,
                description: content.slice(0, 200),
                status,
                result: content,
                order: this.stepCount,
                error: isError ? content : null
            }
        });
        this.sendClientUpdate('agent:step:complete', {
            taskId: this.taskId,
            type,
            status,
            content
        });
    }
}
