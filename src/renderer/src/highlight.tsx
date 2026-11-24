// Tiny syntax highlighter for chat code blocks: comments, strings, numbers, keywords and calls.
// Not a parser; it only has to make common snippets (ts/js, py, sh, json, go, rust) easier to scan.
import type { ReactNode } from 'react'

const KEYWORDS = new Set(
  (
    'as async await break case catch class const continue def default del delete do elif else enum export extends false ' +
    'finally fn for from func function go if impl import in interface is lambda let match mut new nil None null of package ' +
    'pass pub raise return self static struct super switch this throw true True False try type typeof undefined use var ' +
    'void while with yield echo then fi done esac local'
  ).split(' ')
)

const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'rb', 'ruby'])

export function highlight(code: string, lang = ''): ReactNode[] {
  const hash = HASH_COMMENT.has(lang.toLowerCase())
  const re = new RegExp(
    [
      hash ? '(#[^\\n]*)' : '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)', // 1 comment
      '("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)', // 2 string
      '(\\b\\d[\\d_.]*(?:e[+-]?\\d+)?\\b)', // 3 number
      '([A-Za-z_$][\\w$]*)(?=\\s*\\()', // 4 call
      '([A-Za-z_$][\\w$]*)' // 5 word
    ].join('|'),
    'g'
  )
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const [t, comment, str, num, call, word] = m
    const cls = comment ? 'tk-c' : str ? 'tk-s' : num ? 'tk-n' : call ? (KEYWORDS.has(call) ? 'tk-k' : 'tk-f') : word && KEYWORDS.has(word) ? 'tk-k' : null
    out.push(cls ? <span key={k++} className={cls}>{t}</span> : t)
    last = m.index + t.length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
