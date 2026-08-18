export type NumberedInsightText = {
  lead: string;
  points: string[];
};

/**
 * Extracts editorial numbered points without treating the periods in
 * timestamps, decimals or abbreviations as list boundaries.
 *
 * Insight copy commonly uses a short lead followed by `1.`, `2.` and `3.`
 * points. Keeping that structure in the renderer lets the modal expose the
 * relationship as a real nested ordered list instead of flattening it into a
 * misleading sentence list.
 */
export function parseNumberedInsightText(body: string): NumberedInsightText {
  const matches: Array<{ markerStart: number; contentStart: number }> = [];
  const marker = /(^|[,:;.\n]\s*)(\d+)\.\s+(?=[A-Za-z])/g;

  for (const match of body.matchAll(marker)) {
    const fullMatch = match[0];
    const delimiter = match[1] ?? "";
    const matchStart = match.index ?? 0;
    const markerStart = matchStart + delimiter.length;
    matches.push({
      markerStart,
      contentStart: matchStart + fullMatch.length,
    });
  }

  if (!matches.length) return { lead: body.trim(), points: [] };

  const lead = body.slice(0, matches[0]!.markerStart).trim();
  const points = matches.map((current, index) => {
    const next = matches[index + 1];
    return body.slice(current.contentStart, next?.markerStart ?? body.length).trim();
  });

  return { lead, points };
}

const TIMESTAMP_GROUP = /\((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*,\s*(?:\d{1,2}:)?\d{1,2}:\d{2})*\)/g;
const TIMESTAMP = /(?:\d{1,2}:)?\d{1,2}:\d{2}/g;

/**
 * Keeps the second editorial point to one final timestamp group. Older copy
 * sometimes accumulated two parenthesised citations as it was revised, which
 * makes the modal look like two separate asides. The timestamps remain intact
 * but are presented together once.
 */
export function consolidateTimestampGroups(point: string): string {
  const groups = point.match(TIMESTAMP_GROUP) ?? [];
  if (groups.length <= 1) return point;

  const timestamps = [...new Set(groups.flatMap((group) => group.match(TIMESTAMP) ?? []))];
  const text = point
    .replace(TIMESTAMP_GROUP, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[.]$/, "");

  return `${text} (${timestamps.join(", ")}).`;
}

export function splitInsightSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((point) => point.trim())
    .filter(Boolean);
}

/**
 * Determines whether an editorial sentence already carries a specific video
 * timestamp. This prevents the modal from appending a second, identical
 * citation after generated copy that already includes a timestamp group.
 */
export function hasTimestampReference(body: string, timestamp: string): boolean {
  const [minutes, seconds] = timestamp.split(":");
  if (!minutes || !seconds) return false;

  // Source copy can use either `01:17` or the equivalent `1:17`.
  const normalizedMinutes = String(Number(minutes));
  const escapedSeconds = seconds.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9])0?${normalizedMinutes}:${escapedSeconds}(?![0-9])`).test(body);
}
