// ============================================
// AI CODE STUDIO - WEBSOCKET SERVICE
// ============================================

import { v4 as uuidv4 } from 'uuid';
import type { WSEventType, WSMessage, Cursor } from '../types';

type MessageHandler = (data: any) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageQueue: WSMessage[] = [];
  private isConnected = false;
  private userId: string;
  private userName: string;
  private projectId: string | null = null;

  constructor() {
    this.url = `ws://${window.location.host}/ws`;
    this.userId = uuidv4();
    this.userName = 'Anonymous';
  }

  connect(projectId: string, userName?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (userName) this.userName = userName;
      this.projectId = projectId;

      try {
        const token = localStorage.getItem('token');
        this.ws = new WebSocket(`${this.url}?token=${token}&projectId=${projectId}`);

        this.ws.onopen = () => {
          console.log('[WS] Connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          // Join collaboration session
          this.send('collab:join', { 
            projectId, 
            userId: this.userId,
            userName: this.userName 
          });
          
          // Send queued messages
          while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift()!;
            this.ws?.send(JSON.stringify(msg));
          }
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: WSMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (e) {
            console.error('[WS] Parse error:', e);
          }
        };

        this.ws.onclose = () => {
          console.log('[WS] Disconnected');
          this.isConnected = false;
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('[WS] Error:', error);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.projectId = null;
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WS] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      if (this.projectId) {
        this.connect(this.projectId).catch(console.error);
      }
    }, delay);
  }

  private handleMessage(message: WSMessage) {
    const handlers = this.handlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => handler(message.payload));
    }
  }

  send(type: WSEventType | string, payload: any) {
    const message: WSMessage = { type, payload };
    
    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  on(type: WSEventType | string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  off(type: WSEventType | string, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler);
  }

  // ============================================
  // COLLABORATION METHODS
  // ============================================
  
  sendEdit(fileId: string, operation: any) {
    this.send('collab:edit', { fileId, operation, userId: this.userId });
  }

  sendCursor(fileId: string, cursor: Omit<Cursor, 'id' | 'userId' | 'userName' | 'color'>) {
    this.send('collab:cursor', { 
      fileId, 
      ...cursor,
      userId: this.userId,
      userName: this.userName 
    });
  }

  // ============================================
  // AI STREAMING METHODS
  // ============================================
  
  requestCompletion(
    prefix: string, 
    suffix: string, 
    language: string,
    onChunk: (chunk: string) => void,
    onDone: () => void
  ): string {
    const requestId = uuidv4();
    
    const chunkHandler = (data: { requestId: string; chunk: string; done?: boolean }) => {
      if (data.requestId === requestId) {
        if (data.done) {
          this.off('ai:completion:chunk', chunkHandler);
          onDone();
        } else {
          onChunk(data.chunk);
        }
      }
    };
    
    this.on('ai:completion:chunk', chunkHandler);
    this.send('ai:completion', { requestId, prefix, suffix, language });
    
    return requestId;
  }

  streamChat(
    messages: { role: string; content: string }[],
    context: string | null,
    onChunk: (chunk: string) => void,
    onDone: () => void
  ): string {
    const requestId = uuidv4();
    
    const chunkHandler = (data: { requestId: string; chunk: string }) => {
      if (data.requestId === requestId) {
        onChunk(data.chunk);
      }
    };
    
    const endHandler = (data: { requestId: string }) => {
      if (data.requestId === requestId) {
        this.off('ai:chat:chunk', chunkHandler);
        this.off('ai:chat:end', endHandler);
        onDone();
      }
    };
    
    this.on('ai:chat:chunk', chunkHandler);
    this.on('ai:chat:end', endHandler);
    this.send('ai:chat:stream', { requestId, messages, context });
    
    return requestId;
  }

  // ============================================
  // BROWSER AGENT METHODS
  // ============================================
  
  sendBrowserAction(
    action: any,
    onResult: (result: any) => void
  ): string {
    const requestId = uuidv4();
    
    const resultHandler = (data: { requestId: string; result: any }) => {
      if (data.requestId === requestId) {
        this.off('browser:result', resultHandler);
        onResult(data.result);
      }
    };
    
    this.on('browser:result', resultHandler);
    this.send('browser:action', { requestId, action });
    
    return requestId;
  }

  // ============================================
  // PTY TERMINAL METHODS
  // ============================================

  sendTerminalInput(data: string) {
    this.send('terminal:input', { data });
  }

  sendTerminalResize(cols: number, rows: number) {
    this.send('terminal:resize', { cols, rows });
  }

  getUserId() {
    return this.userId;
  }

  getConnectionStatus() {
    return this.isConnected;
  }
}

// Singleton instance
export const wsService = new WebSocketService();
