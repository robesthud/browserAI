// ============================================
// AI CODE STUDIO - API SERVICE
// ============================================

const API_BASE = '/api';

// Helper for API calls
async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'API Error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// ============================================
// AUTH API
// ============================================
export const authAPI = {
  loginWithGitHub: async (code: string) => {
    return fetchAPI<{ token: string; user: any }>('/auth/github', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
  
  getMe: async () => {
    return fetchAPI<{ user: any }>('/auth/me');
  },
  
  logout: async () => {
    return fetchAPI('/auth/logout', { method: 'POST' });
  },
};

// ============================================
// PROJECTS API
// ============================================
export const projectsAPI = {
  list: async () => {
    return fetchAPI<{ projects: any[] }>('/projects');
  },
  
  get: async (id: string) => {
    return fetchAPI<{ project: any }>(`/projects/${id}`);
  },
  
  create: async (data: { name: string; description?: string }) => {
    return fetchAPI<{ project: any }>('/projects', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  
  delete: async (id: string) => {
    return fetchAPI(`/projects/${id}`, { method: 'DELETE' });
  },
  
  getFiles: async (projectId: string) => {
    return fetchAPI<{ files: any[] }>(`/projects/${projectId}/files`);
  },
};

// ============================================
// FILES API
// ============================================
export const filesAPI = {
  get: async (id: string) => {
    return fetchAPI<{ file: any }>(`/files/${id}`);
  },
  
  update: async (id: string, content: string) => {
    return fetchAPI<{ file: any }>(`/files/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },
  
  create: async (projectId: string, path: string, content: string = '') => {
    return fetchAPI<{ file: any }>('/files', {
      method: 'POST',
      body: JSON.stringify({ projectId, path, content }),
    });
  },
  
  rename: async (id: string, newPath: string) => {
    return fetchAPI<{ file: any }>(`/files/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ path: newPath }),
    });
  },
  
  delete: async (id: string) => {
    return fetchAPI(`/files/${id}`, { method: 'DELETE' });
  },
};

// ============================================
// GIT API
// ============================================
export const gitAPI = {
  clone: async (url: string, branch?: string) => {
    return fetchAPI<{ project: any }>('/git/clone', {
      method: 'POST',
      body: JSON.stringify({ url, branch }),
    });
  },
  
  commit: async (projectId: string, message: string, files: { path: string; content: string }[]) => {
    return fetchAPI<{ commit: any }>('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ projectId, message, files }),
    });
  },
  
  push: async (projectId: string) => {
    return fetchAPI('/git/push', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
  },
  
  pull: async (projectId: string) => {
    return fetchAPI('/git/pull', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
  },
  
  getLog: async (projectId: string) => {
    return fetchAPI<{ commits: any[] }>(`/git/log?projectId=${projectId}`);
  },
  
  getBranches: async (projectId: string) => {
    return fetchAPI<{ branches: string[]; current: string }>(`/git/branches?projectId=${projectId}`);
  },
};

// ============================================
// CODE RUNNER API
// ============================================
export const codeAPI = {
  run: async (language: string, code: string, stdin?: string) => {
    return fetchAPI<{
      stdout: string;
      stderr: string;
      exitCode: number;
      executionTimeMs: number;
    }>('/code/run', {
      method: 'POST',
      body: JSON.stringify({ language, code, stdin }),
    });
  },
};

// ============================================
// BROWSER AGENT API
// ============================================
export const browserAPI = {
  executeInstruction: async (instruction: string, startUrl?: string) => {
    return fetchAPI<{
      result: any;
      screenshot?: string;
    }>('/browser/agent', {
      method: 'POST',
      body: JSON.stringify({ instruction, startUrl }),
    });
  },
};

// ============================================
// AI API
// ============================================
export const aiAPI = {
  chat: async (messages: { role: string; content: string }[], context?: string) => {
    return fetchAPI<{ response: string }>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, context }),
    });
  },
  
  complete: async (prefix: string, suffix: string, language: string, provider?: string, model?: string, apiKey?: string) => {
    return fetchAPI<{ completion: string }>('/ai/complete', {
      method: 'POST',
      body: JSON.stringify({ prefix, suffix, language, provider, model, apiKey }),
    });
  },
  
  generateProject: async (goal: string) => {
    return fetchAPI<{ taskId: string }>('/ai/generate-project', {
      method: 'POST',
      body: JSON.stringify({ goal }),
    });
  },
};
