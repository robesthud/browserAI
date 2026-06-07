/**
 * Tiny dependency-free syntax highlighter for our tool-call result blocks.
 *
 * Returns sanitized HTML where tokens are wrapped in <span class="tok-..">.
 * Colours come from src/index.css under .tok-* selectors. Languages are
 * detected from the file extension passed in; pass '' for plain text.
 *
 * It is deliberately simple — won't replace Prism/Shiki — but it makes
 * read_file / write_file output readable on a phone without pulling
 * 200kb of JS into the mobile bundle.
 */
function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function langFromExt(ext = '') {
  const e = String(ext || '').toLowerCase().replace(/^\./, '')
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(e)) return 'js'
  if (e === 'json') return 'json'
  if (e === 'py') return 'py'
  if (e === 'sh' || e === 'bash' || e === 'zsh') return 'sh'
  if (e === 'html' || e === 'xml' || e === 'svg' || e === 'vue') return 'html'
  if (e === 'css' || e === 'scss' || e === 'sass') return 'css'
  if (e === 'md' || e === 'markdown') return 'md'
  if (e === 'yml' || e === 'yaml') return 'yaml'
  if (e === 'toml' || e === 'ini') return 'toml'
  return ''
}

// A single shared tokenizer driven by per-language rule tables. Each rule
// matches greedily from the cursor position and either returns a token
// class or null to fall through.
const RULES = {
  js: [
    { name: 'com',   re: /\/\/[^\n]*/y },
    { name: 'com',   re: /\/\*[\s\S]*?\*\//y },
    { name: 'str',   re: /`(?:\\.|\$\{[^}]*\}|[^`\\])*`/y },
    { name: 'str',   re: /"(?:\\.|[^"\\])*"/y },
    { name: 'str',   re: /'(?:\\.|[^'\\])*'/y },
    { name: 'num',   re: /\b\d[\d_.eE]*\b/y },
    { name: 'key',   re: /\b(?:import|export|from|as|default|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|true|false|null|undefined)\b/y },
    { name: 'ttype', re: /\b[A-Z][A-Za-z0-9_]*\b/y },
    { name: 'fn',    re: /\b[a-zA-Z_$][\w$]*(?=\s*\()/y },
  ],
  json: [
    { name: 'str',  re: /"(?:\\.|[^"\\])*"/y },
    { name: 'num',  re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
    { name: 'key',  re: /\b(?:true|false|null)\b/y },
  ],
  py: [
    { name: 'com',  re: /#[^\n]*/y },
    { name: 'str',  re: /[rRbBuU]?"""[\s\S]*?"""/y },
    { name: 'str',  re: /[rRbBuU]?'''[\s\S]*?'''/y },
    { name: 'str',  re: /[rRbBuU]?"(?:\\.|[^"\\])*"/y },
    { name: 'str',  re: /[rRbBuU]?'(?:\\.|[^'\\])*'/y },
    { name: 'num',  re: /\b\d[\d_.eE]*\b/y },
    { name: 'key',  re: /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|pass|lambda|yield|global|nonlocal|async|await|self|cls)\b/y },
    { name: 'fn',   re: /\b[a-zA-Z_][\w]*(?=\s*\()/y },
  ],
  sh: [
    { name: 'com',  re: /#[^\n]*/y },
    { name: 'str',  re: /"(?:\\.|[^"\\])*"/y },
    { name: 'str',  re: /'[^']*'/y },
    { name: 'key',  re: /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|export|local|readonly)\b/y },
    { name: 'fn',   re: /\$[A-Za-z_][\w]*|\$\{[^}]+\}/y },
  ],
  html: [
    { name: 'com',  re: /<!--[\s\S]*?-->/y },
    { name: 'str',  re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
    { name: 'ttype',re: /<\/?[A-Za-z][A-Za-z0-9-]*/y },
    { name: 'key',  re: /\b[a-zA-Z-]+(?==)/y },
  ],
  css: [
    { name: 'com',  re: /\/\*[\s\S]*?\*\//y },
    { name: 'str',  re: /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y },
    { name: 'num',  re: /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg)?\b/y },
    { name: 'key',  re: /[#.][\w-]+/y },
    { name: 'fn',   re: /\b[a-z-]+(?=\s*:)/y },
  ],
  yaml: [
    { name: 'com',  re: /#[^\n]*/y },
    { name: 'str',  re: /"(?:\\.|[^"\\])*"|'[^']*'/y },
    { name: 'key',  re: /^[ \t]*[\w-]+(?=:)/my },
    { name: 'num',  re: /\b\d[\d_.eE]*\b/y },
  ],
  toml: [
    { name: 'com',  re: /#[^\n]*/y },
    { name: 'str',  re: /"(?:\\.|[^"\\])*"|'[^']*'/y },
    { name: 'key',  re: /^[ \t]*[\w.-]+(?=\s*=)/my },
    { name: 'ttype',re: /^\[\[?[\w.-]+\]?\]/my },
    { name: 'num',  re: /\b\d[\d_.eE]*\b/y },
  ],
  md: [
    { name: 'com',  re: /^>.*$/my },
    { name: 'key',  re: /^#{1,6}[^\n]*/my },
    { name: 'str',  re: /`[^`\n]+`/y },
    { name: 'fn',   re: /\*\*[^*\n]+\*\*|__[^_\n]+__/y },
  ],
}

const WS_RE = /\s+/y
const ANY_RE = /[^\s]/y

export function highlight(text, ext) {
  const lang = langFromExt(ext)
  if (!lang || !RULES[lang]) return escape(text)

  const rules = RULES[lang]
  const out = []
  let i = 0
  const src = String(text || '')

  while (i < src.length) {
    // Whitespace passthrough
    WS_RE.lastIndex = i
    const ws = WS_RE.exec(src)
    if (ws && ws.index === i) { out.push(escape(ws[0])); i = WS_RE.lastIndex; continue }

    let matched = null
    for (const rule of rules) {
      rule.re.lastIndex = i
      const m = rule.re.exec(src)
      if (m && m.index === i) { matched = { name: rule.name, str: m[0] }; break }
    }

    if (matched) {
      out.push(`<span class="tok-${matched.name}">${escape(matched.str)}</span>`)
      i += matched.str.length
    } else {
      // Single character fallback
      out.push(escape(src[i]))
      i += 1
    }
  }

  return out.join('')
}

export function detectLangFromPath(path = '') {
  const dot = String(path).lastIndexOf('.')
  if (dot < 0) return ''
  return langFromExt(path.slice(dot + 1))
}
