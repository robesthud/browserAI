function openaiToAnthropicTools(tools = []) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }))
}

function openaiToGeminiTools(tools = []) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} }
    }))
  }]
}
console.log(openaiToAnthropicTools([{type: 'function', function: {name: 'test', parameters: {type: 'object'}}}]));
