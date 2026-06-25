/**
 * BrowserAI Agent Runtime (Privileged)
 * 
 * This is the core "platform" layer — analogous to Arena's runtime.
 * 
 * Philosophy (exactly like Arena):
 * - LLM only decides: which tool + arguments
 * - Runtime executes with real process privileges
 */

export { PRIVILEGED_TOOLS } from './privilegedTools.js';

// Future: you can add more runtime modules here
// export { FileRuntime } from './file.js';
// export { GitRuntime } from './git.js';
