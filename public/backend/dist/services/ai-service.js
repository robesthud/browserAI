import { AIAdapter } from './aiAdapter.js';
export class AIService {
    static async chat(config, messages) {
        return AIAdapter.chat(config, messages);
    }
    static async streamChat(config, messages, callbacks) {
        return AIAdapter.streamChat(config, messages, callbacks);
    }
    static async complete(config, prefix, suffix, language) {
        return AIAdapter.complete(config, prefix, suffix, language);
    }
}
