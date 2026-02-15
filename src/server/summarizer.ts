import { runQuery } from './db.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

export async function summarizeOutput(
  commandId: string,
  agentId: string,
  rawOutput: string,
  workingDirectory: string,
  onSummary: (commandId: string, summary: string, filesChanged: string[]) => void
): Promise<void> {
  if (!ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set, skipping summarization');
    return;
  }

  // Truncate to last ~4000 chars
  const truncated = rawOutput.length > 4000 ? rawOutput.slice(-4000) : rawOutput;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 256,
        system: 'Summarize this Claude Code session output in 2-3 sentences. Focus on: what was accomplished, files changed, any errors. Be terse and specific. Also list any file paths that were modified.',
        messages: [{ role: 'user', content: truncated }],
      }),
    });

    if (!response.ok) {
      console.error('Summarization API error:', response.status);
      return;
    }

    const data = await response.json() as { content: Array<{ text: string }> };
    const summary = data.content?.[0]?.text || '';

    // Extract file paths from summary
    const filePattern = /(?:src|lib|components|hooks|screens|server|client)\/[\w\-./]+\.\w+/g;
    const filesChanged = (summary.match(filePattern) || []) as string[];

    // Update command in DB
    runQuery(
      `UPDATE commands SET summary = ?, files_changed = ?, status = 'done', completed_at = ? WHERE id = ?`,
      [summary, JSON.stringify(filesChanged), new Date().toISOString(), commandId]
    );

    onSummary(commandId, summary, filesChanged);
  } catch (error) {
    console.error('Summarization error:', error);
  }
}
