/**
 * Agent Runtime Platform Bootstrap
 * Loads privileged execution by default.
 */
import { PRIVILEGED_TOOLS } from './privilegedTools.js';
import { isPrivilegedMode, getRuntimeName } from './RUNTIME_MODE.js';

export function getRuntimeTools() {
  return PRIVILEGED_TOOLS;
}

export const RUNTIME_INFO = {
  name: getRuntimeName(),
  mode: process.env.BROWSERAI_RUNTIME_MODE || 'privileged',
  privileged: true,
};
