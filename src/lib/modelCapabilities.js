export function getModelCapabilities(model = '', baseUrl = '') {
  const id = String(model || '').toLowerCase()
  const url = String(baseUrl || '').toLowerCase()
  const isGateway = url.includes('browserai.local/free-gateway')
  const isGemini = id.includes('gemini') || url.includes('generativelanguage.googleapis.com') || url.includes('host.docker.internal:8080') || (isGateway && id.includes('gemini'))
  const isVision = isGemini || id.includes('gpt-4o') || id.includes('vision') || id.includes('-vl') || id.includes('qwen-vl') || id.includes('claude-3')
  const imageOutput = isGemini || id.includes('imagen') || id.includes('dall') || id.includes('flux') || id.includes('stable') || id.includes('sdxl')
  const videoOutput = isGemini || id.includes('veo') || id.includes('video')
  const documentOutput = true
  return {
    text: true,
    imageInput: Boolean(isVision),
    imageOutput: Boolean(imageOutput),
    videoOutput: Boolean(videoOutput),
    documentOutput,
    multimodal: Boolean(isVision),
  }
}

export function isImageAttachment(a) {
  const type = String(a?.type || a?.mime || '')
  const url = String(a?.dataUrl || '')
  return type.startsWith('image/') || url.startsWith('data:image/')
}
