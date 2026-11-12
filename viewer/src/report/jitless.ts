import { z } from 'zod';

// The page's CSP has no 'unsafe-eval'. zod probes `new Function` when it builds an object
// schema unless `jitless` is set, and browsers report the probe as a CSP violation even though
// zod catches the error. So this module runs before any module that builds a schema: it is the
// first import of `main.tsx` and of `readEmbeddedReport.ts`.
z.config({ jitless: true });
