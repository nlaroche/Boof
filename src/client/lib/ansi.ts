const COLORS_30_37 = [
  '#0a0a0f', // 30 black
  '#ef4444', // 31 red
  '#22c55e', // 32 green
  '#eab308', // 33 yellow
  '#3b82f6', // 34 blue
  '#a855f7', // 35 magenta
  '#06b6d4', // 36 cyan
  '#f5f5f4', // 37 white
];

const COLORS_90_97 = [
  '#6b7280', // 90 bright black (gray)
  '#f87171', // 91 bright red
  '#4ade80', // 92 bright green
  '#facc15', // 93 bright yellow
  '#60a5fa', // 94 bright blue
  '#c084fc', // 95 bright magenta
  '#22d3ee', // 96 bright cyan
  '#ffffff', // 97 bright white
];

export function ansiToHtml(text: string): string {
  let result = '';
  let buffer = '';
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;

  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      result += buffer;
      buffer = '';

      let j = i + 2;
      while (j < text.length && text[j] >= '0' && text[j] <= '9' || text[j] === ';') {
        j++;
      }

      const codeStr = text.slice(i + 2, j);
      const codes = codeStr.split(';').map(s => parseInt(s, 10) || 0);

      for (const code of codes) {
        if (code >= 30 && code <= 37) {
          fg = COLORS_30_37[code - 30];
        } else if (code >= 90 && code <= 97) {
          fg = COLORS_90_97[code - 90];
        } else if (code >= 40 && code <= 47) {
          bg = COLORS_30_37[code - 40];
        } else if (code >= 100 && code <= 107) {
          bg = COLORS_90_97[code - 100];
        } else if (code === 1) {
          bold = true;
        } else if (code === 0) {
          fg = null;
          bg = null;
          bold = false;
        } else if (code === 39) {
          fg = null;
        } else if (code === 49) {
          bg = null;
        }
      }

      i = j;
      if (text[i] === 'm') i++;
    } else {
      buffer += text[i];
      i++;
    }
  }

  result += buffer;

  if (fg || bg || bold) {
    const style: string[] = [];
    if (fg) style.push(`color: ${fg}`);
    if (bg) style.push(`background-color: ${bg}`);
    const styleAttr = style.length > 0 ? ` style="${style.join('; ')}"` : '';
    const content = bold ? `<strong>${result}</strong>` : result;
    return `<span${styleAttr}>${content}</span>`;
  }

  return result;
}
