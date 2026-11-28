/**
 * Output cleanup for compaction summaries (pure function, easy to unit test).
 *
 * The summary prompt asks the model to first write an `<analysis>` draft and then put the
 * final checkpoint inside `<summary>`:
 * - the draft improves recall (think first, conclude later) and **never enters context**;
 * - only the body inside `<summary>` is kept in the final artifact.
 *
 * When the model does not follow the format (older models / gateway truncation), degrade:
 * drop the analysis and keep the rest of the text; better to keep too much than to throw
 * away the whole summary because of a format mismatch.
 */
export function extractCheckpointText(raw: string): string {
  const text = (raw ?? '').trim()
  if (!text) return ''

  // Strip the <analysis> draft first: otherwise a literal "<summary>" mentioned inside the
  // draft would mislead the regex below
  const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim()

  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch) return summaryMatch[1].trim()

  // No <summary> wrapper (the model did not follow the format): strip leftover tags and keep the rest
  return withoutAnalysis.replace(/<\/?summary>/gi, '').trim()
}
