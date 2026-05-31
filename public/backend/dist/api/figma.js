// ============================================
// AI CODE STUDIO - FIGMA INTEGRATION ROUTE
// Bypasses CORS and calls Figma API to generate code
// ============================================
import { AIAdapter } from '../services/aiAdapter.js';
export async function figmaRoutes(fastify) {
    fastify.post('/generate-code', async (request, reply) => {
        const { figmaUrl, personalToken, aiConfig } = request.body;
        if (!figmaUrl || !personalToken) {
            return reply.code(400).send({ error: 'Missing figmaUrl or personalToken' });
        }
        try {
            // 1. Extract file key from URL
            // Figma URLs look like: https://www.figma.com/file/FILE_KEY/title...
            const fileKeyMatch = figmaUrl.match(/\/file\/([^/]+)/);
            if (!fileKeyMatch) {
                return reply.code(400).send({ error: 'Invalid Figma File URL' });
            }
            const fileKey = fileKeyMatch[1];
            // 2. Fetch file content from Figma REST API
            const figmaResponse = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
                headers: {
                    'X-Figma-Token': personalToken,
                },
            });
            if (!figmaResponse.ok) {
                const errText = await figmaResponse.text();
                return reply.code(figmaResponse.status).send({ error: `Figma API Error: ${errText}` });
            }
            const figmaData = await figmaResponse.json();
            // 3. Extract basic node structural details to keep LLM context size reasonable
            const documentName = figmaData.name;
            const simplifiedNodes = extractSimplifiedNodes(figmaData.document);
            // 4. Use AI Adapter to translate the design tokens/nodes into gorgeous HTML/CSS/Tailwind React code!
            const translationPrompt = `
        You are an expert Frontend Developer AI.
        Translate the following simplified Figma design token hierarchy from the file "${documentName}" into a modern React component styled with Tailwind CSS.
        
        Design Hierarchy:
        ${JSON.stringify(simplifiedNodes, null, 2)}

        Return ONLY the React code. Do not write explanations, do not include markdown backticks. Keep the layout responsive and match the element names and offsets where appropriate.
      `;
            const generatedCode = await AIAdapter.chat(aiConfig, [
                { role: 'system', content: 'You are a professional frontend React developer. Output only code.' },
                { role: 'user', content: translationPrompt }
            ]);
            const cleanCode = generatedCode.replace(/```\w*/g, '').replace(/```/g, '').trim();
            return {
                success: true,
                documentName,
                code: cleanCode,
            };
        }
        catch (error) {
            console.error('Figma Translation Error:', error);
            return reply.code(500).send({ error: `Figma Translation Error: ${String(error)}` });
        }
    });
}
// Helper to keep document hierarchy extremely concise for LLM context limits
function extractSimplifiedNodes(node, depth = 0) {
    if (depth > 4)
        return null; // Avoid extremely deep trees
    const simplified = {
        id: node.id,
        name: node.name,
        type: node.type,
    };
    if (node.absoluteBoundingBox) {
        simplified.bounds = {
            width: node.absoluteBoundingBox.width,
            height: node.absoluteBoundingBox.height,
        };
    }
    if (node.fills && node.fills.length > 0) {
        simplified.colors = node.fills
            .filter((f) => f.type === 'SOLID')
            .map((f) => f.color);
    }
    if (node.characters) {
        simplified.text = node.characters.slice(0, 100);
    }
    if (node.children && node.children.length > 0) {
        simplified.children = node.children
            .map((c) => extractSimplifiedNodes(c, depth + 1))
            .filter(Boolean)
            .slice(0, 10); // Limit to top 10 children to avoid massive context
    }
    return simplified;
}
