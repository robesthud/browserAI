// ============================================
// AI CODE STUDIO - BROWSER AGENT SERVICE
// Sends browser commands to the Playwright container
// ============================================

const BROWSER_AI_URL = process.env.BROWSER_AI_URL || 'http://localhost:8080';

export class BrowserAgentService {
  static async executeAction(action: any) {
    const response = await fetch(`${BROWSER_AI_URL}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });

    if (!response.ok) {
      throw new Error(`Browser Agent action failed: ${response.statusText}`);
    }

    return response.json();
  }

  static async executeAgentInstruction(instruction: string, startUrl?: string, sessionId = 'default') {
    const response = await fetch(`${BROWSER_AI_URL}/api/browser/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, startUrl, sessionId }),
    });

    if (!response.ok) {
      throw new Error(`Browser Agent instruction failed: ${response.statusText}`);
    }

    return response.json();
  }
}
