// ============================================
// AI CODE STUDIO - CODE RUNNER CLIENT SERVICE
// Communicates with FastAPI Code Runner service
// ============================================
const CODE_RUNNER_URL = process.env.CODE_RUNNER_URL || 'http://localhost:8000';
export class CodeRunnerClient {
    static async run(language, code, stdin = '', timeout = 10, memoryLimit = 256) {
        const response = await fetch(`${CODE_RUNNER_URL}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language,
                code,
                stdin,
                timeout,
                memory_limit: memoryLimit
            })
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || `Code execution failed with status: ${response.status}`);
        }
        return response.json();
    }
    static async getSupportedLanguages() {
        const response = await fetch(`${CODE_RUNNER_URL}/languages`);
        if (!response.ok)
            throw new Error('Failed to fetch supported languages');
        return response.json();
    }
    static async checkHealth() {
        try {
            const response = await fetch(`${CODE_RUNNER_URL}/health`);
            return response.ok;
        }
        catch {
            return false;
        }
    }
}
