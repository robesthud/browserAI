import { AIAdapter, type Message, type AIConfig } from './aiAdapter.js';

export class AIService {
  static async chat(config: AIConfig, messages: Message[]) {
    return AIAdapter.chat(config, messages);
  }

  static async streamChat(config: AIConfig, messages: Message[], callbacks: any) {
    return AIAdapter.streamChat(config, messages, callbacks);
  }

  static async complete(config: AIConfig, prefix: string, suffix: string, language: string) {
    return AIAdapter.complete(config, prefix, suffix, language);
  }
}
