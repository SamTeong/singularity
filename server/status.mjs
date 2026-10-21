// Pure compatibility fixture retained for the Node-side normalization tests.
export const STATUS_PROVIDERS = [
  { key: 'openai', label: 'OpenAI', url: 'https://status.openai.com' },
  { key: 'claude', label: 'Claude', url: 'https://status.claude.com' },
];

// Statuspage `summary.json` → flat shape the Status view renders. Pure so the
// test can exercise it without the network.
export function normalizeStatus(raw, provider) {
  const comp = (raw.components || [])
    .filter((c) => c && c.group !== true && c.status) // drop group containers, keep leaves with a real status
    .map((c) => ({ name: c.name, status: c.status }));
  const incident = (i) => ({
    name: i.name,
    impact: i.impact, // none|minor|major|critical|maintenance
    status: i.status,
    shortlink: i.shortlink,
    createdAt: i.created_at ?? null,
  });
  return {
    ok: true,
    key: provider.key,
    label: provider.label,
    pageUrl: provider.url,
    updatedAt: raw.page?.updated_at ?? null,
    indicator: raw.status?.indicator ?? 'none', // none|minor|major|critical|maintenance
    description: raw.status?.description ?? '',
    components: comp,
    incidents: (raw.incidents || []).map(incident),
    maintenances: (raw.scheduled_maintenances || []).map(incident),
  };
}
