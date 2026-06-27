export function getModelCapabilities(model = '', baseUrl = '') {
  const id = String(model || '').toLowerCase()
  const url = String(baseUrl || '').toLowerCase()
  // Gemini = direct Google AI Studio API. free-gateway / gemini-web-proxy
  // были удалены — capabilities остались только для настоящих провайдеров.
  const isGemini = id.includes('gemini') || url.includes('generativelanguage.googleapis.com')
  const isVision = isGemini || id.includes('gpt-4o') || id.includes('vision') || id.includes('-vl') || id.includes('qwen-vl') || id.includes('claude-3')
  const imageOutput = (isGemini && id.includes('image')) || id.includes('imagen') || id.includes('dall') || id.includes('flux') || id.includes('stable') || id.includes('sdxl')
  const videoOutput = (isGemini && id.includes('veo')) || id.includes('veo') || id.includes('video')
  const documentOutput = true
  const broadFileInput = isGemini
  return {
    text: true,
    imageInput: Boolean(isVision),
    documentInput: Boolean(broadFileInput),
    spreadsheetInput: Boolean(broadFileInput),
    presentationInput: Boolean(broadFileInput),
    audioInput: Boolean(broadFileInput),
    videoInput: Boolean(broadFileInput),
    archiveInput: Boolean(broadFileInput),
    codeInput: Boolean(broadFileInput),
    imageOutput: Boolean(imageOutput),
    videoOutput: Boolean(videoOutput),
    documentOutput,
    multimodal: Boolean(isVision || broadFileInput),
  }
}

export function getAttachmentKind(a) {
  const type = String(a?.type || a?.mime || '')
  const url = String(a?.dataUrl || '')
  const name = String(a?.name || a?.path || '').toLowerCase()
  if (type.startsWith('image/') || url.startsWith('data:image/')) return 'image'
  if (type.startsWith('video/') || url.startsWith('data:video/')) return 'video'
  if (type.startsWith('audio/') || url.startsWith('data:audio/')) return 'audio'
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'document'
  if (type.includes('presentation') || /\.(ppt|pptx|odp)$/.test(name)) return 'presentation'
  if (type.includes('spreadsheet') || type.includes('excel') || /\.(xls|xlsx|csv|tsv|ods)$/.test(name)) return 'spreadsheet'
  if (/\.(doc|docx|rtf|txt|md|html|htm|odt)$/.test(name)) return 'document'
  if (/\.(zip|tar|tgz|gz|rar|7z)$/.test(name)) return 'archive'
  if (/\.(js|jsx|ts|tsx|py|java|go|rs|cpp|c|h|css|json|yaml|yml|xml|sql|sh)$/.test(name)) return 'code'
  return 'binary'
}

export function isImageAttachment(a) {
  return getAttachmentKind(a) === 'image'
}

export function canSendAttachmentToModel(a, capabilities = {}) {
  const kind = getAttachmentKind(a)
  if (kind === 'image') return Boolean(capabilities.imageInput)
  if (kind === 'video') return Boolean(capabilities.videoInput)
  if (kind === 'audio') return Boolean(capabilities.audioInput)
  if (kind === 'document') return Boolean(capabilities.documentInput)
  if (kind === 'presentation') return Boolean(capabilities.presentationInput)
  if (kind === 'spreadsheet') return Boolean(capabilities.spreadsheetInput)
  if (kind === 'archive') return Boolean(capabilities.archiveInput)
  if (kind === 'code') return Boolean(capabilities.codeInput)
  return Boolean(capabilities.documentInput)
}
