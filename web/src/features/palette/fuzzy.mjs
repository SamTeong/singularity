// Fuzzy score: higher = better, null = no match. Empty query = 0 (show all).
// Rules: case-insensitive; exact keyword alias highest; label substring by
// position (earlier = better); keyword prefix/substring; label subsequence
// (initials-style order). Pure, no deps.
export function score(query, { label, keywords = [] }) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  for (const kw of keywords) if (kw.toLowerCase() === q) return 1000; // exact alias
  const li = l.indexOf(q);
  if (li >= 0) return 500 - li; // label substring, earlier = higher
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.startsWith(q)) return 400; // keyword prefix
    const ki = k.indexOf(q);
    if (ki > 0) return 300 - ki; // keyword substring
  }
  return subseq(q, l) ? 50 : null; // label subsequence (order)
}

function subseq(q, l) {
  let i = 0;
  for (const ch of l) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}
