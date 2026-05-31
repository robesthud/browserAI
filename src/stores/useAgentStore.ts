// ============================================
// AI CODE STUDIO - AGENT STORE (ZUSTAND)
// Supports real-time WebSocket ReAct Agent updates
// ============================================

import { create } from 'zustand';

export interface AgentStepUI {
  id: string;
  type: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: string;
  error?: string;
  order: number;
}

export interface AgentTaskUI {
  id: string;
  goal: string;
  steps: AgentStepUI[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
}

interface AgentStore {
  currentTask: AgentTaskUI | null;
  isRunning: boolean;
  setCurrentTask: (task: AgentTaskUI | null) => void;
  addStep: (step: AgentStepUI) => void;
  updateStepStatus: (stepId: string, status: AgentStepUI['status'], result?: string, error?: string) => void;
  completeTask: () => void;
  failTask: (error: string) => void;
  cancelTask: () => void;
  clearTask: () => void;
}

export const useAgentStore = create<AgentStore>((set) => ({
  currentTask: null,
  isRunning: false,

  setCurrentTask: (task) => set({ currentTask: task, isRunning: task?.status === 'running' || task?.status === 'pending' }),
  
  addStep: (step) => set((state) => {
    if (!state.currentTask) return {};
    
    // Check for duplicate steps
    const stepExists = state.currentTask.steps.some(s => s.id === step.id);
    const updatedSteps = stepExists
      ? state.currentTask.steps.map(s => s.id === step.id ? { ...s, ...step } : s)
      : [...state.currentTask.steps, step].sort((a, b) => a.order - b.order);

    return {
      currentTask: {
        ...state.currentTask,
        steps: updatedSteps
      }
    };
  }),

  updateStepStatus: (stepId, status, result, error) => set((state) => {
    if (!state.currentTask) return {};
    
    const updatedSteps = state.currentTask.steps.map((step) => {
      if (step.id === stepId) {
        return { ...step, status, result, error };
      }
      return step;
    });

    return {
      currentTask: {
        ...state.currentTask,
        steps: updatedSteps
      }
    };
  }),

  completeTask: () => set((state) => {
    if (!state.currentTask) return {};
    return {
      isRunning: false,
      currentTask: {
        ...state.currentTask,
        status: 'completed'
      }
    };
  }),

  failTask: () => set((state) => {
    if (!state.currentTask) return {};
    return {
      isRunning: false,
      currentTask: {
        ...state.currentTask,
        status: 'failed'
      }
    };
  }),

  cancelTask: () => set((state) => {
    if (!state.currentTask) return {};
    return {
      isRunning: false,
      currentTask: {
        ...state.currentTask,
        status: 'cancelled'
      }
    };
  }),

  clearTask: () => set({ currentTask: null, isRunning: false })
}));
export default useAgentStore;
