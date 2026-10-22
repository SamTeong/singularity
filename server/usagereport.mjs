const SKILL_STATS = process.env.SING_USAGE_SKILL;
const REPORTS_DIR = process.env.SING_USAGE_REPORTS ?? '';

let backend;

export function setUsageReportBackend(value) {
  backend = value;
}

function requiredBackend() {
  if (!backend) throw new Error('Usage report Rust backend is not configured');
  return backend;
}

export async function reportStatus() {
  return requiredBackend().usageReportStatus(REPORTS_DIR, SKILL_STATS);
}

export async function latestReportHtml() {
  const result = await requiredBackend().usageReportRead(REPORTS_DIR, SKILL_STATS);
  return result?.html ?? null;
}

export async function generateReport() {
  return requiredBackend().usageReportGenerate(REPORTS_DIR, SKILL_STATS);
}

export function createUsageReportHandlers() {
  return {
    status: async () => reportStatus(),
    report: async (_request, reply) => {
      const html = await latestReportHtml();
      if (html == null) return reply.code(404).send({ ok: false, error: 'no report' });
      return reply.type('text/html').send(html);
    },
    refresh: async (_request, reply) => {
      const result = await generateReport();
      if (!result.ok) reply.code(400);
      return result;
    },
  };
}
