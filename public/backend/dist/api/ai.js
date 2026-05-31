// ============================================
// AI CODE STUDIO - AI SERVICE ROUTE
// Handles real-time code completion endpoints
// ============================================
import { AIAdapter } from '../services/aiAdapter.js';
export async function aiRoutes(fastify) {
    fastify.post('/complete', async (request, reply) => {
        const { prefix, suffix, language, provider, model, apiKey } = request.body;
        if (!prefix && !suffix) {
            return reply.code(400).send({ error: 'Missing prefix or suffix context' });
        }
        try {
            // Resolve provider settings from request body or fallback to env keys
            const resolvedProvider = provider || 'openai';
            const resolvedApiKey = apiKey || getEnvApiKey(resolvedProvider) || '';
            const resolvedModel = model || '';
            const completion = await AIAdapter.complete({
                provider: resolvedProvider,
                apiKey: resolvedApiKey,
                model: resolvedModel,
            }, prefix, suffix, language);
            return { completion };
        }
        catch (error) {
            console.error('Real-time AI Autocomplete Error:', error);
            return reply.code(500).send({ error: error.message || 'Internal Autocomplete service error' });
        }
    });
}
function getEnvApiKey(provider) {
    switch (provider) {
        case 'openai': return process.env.OPENAI_API_KEY || '';
        case 'anthropic': return process.env.ANTHROPIC_API_KEY || '';
        case 'google': return process.env.GOOGLE_AI_API_KEY || '';
        case 'groq': return process.env.GROQ_API_KEY || '';
        case 'deepseek': return process.env.DEEPSEEK_API_KEY || '';
        case 'mistral': return process.env.MISTRAL_API_KEY || '';
        case 'qwen': return process.env.QWEN_API_KEY || '';
        default: return '';
    }
}
