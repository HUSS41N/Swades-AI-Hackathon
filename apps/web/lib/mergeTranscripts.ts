/**
 * Merge a new overlapping-window transcript into stable text by matching
 * repeated words at the boundary (2s overlap ≈ duplicate phrase tail/head).
 */
export function mergeOverlappingTranscripts(
  stable: string,
  incoming: string,
): string {
  const sa = stable.trim();
  const ib = incoming.trim();
  if (!ib) {
    return stable;
  }
  if (!sa) {
    return ib;
  }

  const aWords = sa.split(/\s+/).filter(Boolean);
  const bWords = ib.split(/\s+/).filter(Boolean);
  const maxCheck = Math.min(aWords.length, bWords.length, 80);

  let best = 0;
  for (let k = maxCheck; k >= 1; k--) {
    const suf = aWords.slice(-k).join(" ").toLowerCase();
    const pref = bWords.slice(0, k).join(" ").toLowerCase();
    if (suf === pref) {
      best = k;
      break;
    }
  }

  const rest = best > 0 ? bWords.slice(best).join(" ") : ib;
  if (!rest) {
    return stable;
  }
  return `${sa} ${rest}`.trim();
}
