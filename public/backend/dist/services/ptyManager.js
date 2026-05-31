// ============================================
// AI CODE STUDIO - PTY MANAGER (node-pty)
// Spawns and manages pseudo-terminal sessions securely
// ============================================
import pty from 'node-pty';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { WebSocket } from 'ws';
const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const isWindows = process.platform === 'win32';
const shell = isWindows ? 'powershell.exe' : 'bash';
export class PTYManager {
    static sessions = new Map();
    /**
     * Spawns a new PTY instance or retrieves existing one for this socket/project
     */
    static async createSession(sessionId, projectId, ws) {
        if (this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId);
        }
        const workingDir = join(PROJECTS_DIR, projectId || 'default');
        try {
            await mkdir(workingDir, { recursive: true });
        }
        catch { }
        console.log(`[PTY] Spawning shell (${shell}) in: ${workingDir}`);
        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: workingDir,
            env: process.env,
        });
        // Handle process output, forward to the WebSocket client
        ptyProcess.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'terminal:output',
                    payload: { sessionId, data },
                }));
            }
        });
        ptyProcess.onExit((code) => {
            console.log(`[PTY] Shell session ${sessionId} exited with code: ${code.exitCode}`);
            this.sessions.delete(sessionId);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'terminal:exit',
                    payload: { sessionId, exitCode: code.exitCode },
                }));
            }
        });
        this.sessions.set(sessionId, ptyProcess);
        return ptyProcess;
    }
    /**
     * Send text input (keystrokes) to the PTY process
     */
    static write(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.write(data);
        }
    }
    /**
     * Handle terminal resize events
     */
    static resize(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (session) {
            try {
                session.resize(cols, rows);
            }
            catch (err) {
                console.error(`[PTY] Resize failed for ${sessionId}:`, err);
            }
        }
    }
    /**
     * Kill shell session gracefully or force destroy
     */
    static killSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            console.log(`[PTY] Killing shell session: ${sessionId}`);
            try {
                session.kill();
            }
            catch { }
            this.sessions.delete(sessionId);
        }
    }
}
