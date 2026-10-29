export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; language: string }

// Parse fences as text, never HTML. An unfinished fence is still a block while the
// answer streams in; retain its whitespace verbatim for copying commands/configs.
export function assistantBlocks(text: string): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  let content = ''
  let fence: string | undefined
  let language = ''
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[\t ]*(?:\r?\n)?$/.exec(line)
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        blocks.push({ kind: 'code', text: content, language })
        content = ''
        fence = undefined
      } else {
        content += line
      }
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/.exec(line)
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        if (content) blocks.push({ kind: 'text', text: content })
        content = ''
        fence = opening[1]
        language = opening[2].trim().split(/\s+/)[0]
      } else {
        content += line
      }
    }
  }
  if (fence) blocks.push({ kind: 'code', text: content, language })
  else if (content) blocks.push({ kind: 'text', text: content })
  return blocks
}
