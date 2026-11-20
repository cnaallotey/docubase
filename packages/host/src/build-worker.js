// Runs in a separate process with a memory limit and an empty environment. It reads the customer's
// docs, which are only Markdown and an optional OpenAPI file, and writes the built site.
import { build } from 'docubase/src/build.js';
import { loadSite } from '@docubase/core';

process.on('message', async (job) => {
  try {
    const site = await loadSite(job.root, { configOverrides: { base: '/' } });
    const result = await build(site, { out: job.out, safe: false });
    const a = site.config.assistant;
    process.send({
      ok: true,
      pages: result.pages,
      warnings: site.warnings.slice(0, 20).map((w) => String(w).slice(0, 300)),
      config: { title: site.config.title, assistant: a, mcp: site.config.mcp },
    });
  } catch (error) {
    process.send({ ok: false, error: String(error && error.message ? error.message : error).slice(0, 500) });
  }
  process.exit(0);
});
