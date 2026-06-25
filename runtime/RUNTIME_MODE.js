/**
 * Agent Runtime Platform - Mode Controller
 * 
 * This enables "Privileged Agent Runtime" behavior.
 */
export const RUNTIME_MODE = process.env.BROWSERAI_RUNTIME_MODE || 'privileged';

export const isPrivilegedMode = () => RUNTIME_MODE === 'privileged' || RUNTIME_MODE === 'full';

export const getRuntimeName = () => 'Privileged Agent Runtime Platform';

export const getPreferredToolPrefix = () => isPrivilegedMode() ? 'host_' : '';
