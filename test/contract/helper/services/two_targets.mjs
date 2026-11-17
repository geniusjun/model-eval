// An adapter with two targets: `drafted` renders and has no post-processing, `plain` has neither
// (helper-api §Target Options, `render` and `postprocess`).

import { helperExport } from './support.mjs';

helperExport('defineAdapter')({
  name: 'two-targets',
  version: '0.0.1',
  targets: {
    drafted: {
      render: true,
      postprocess: false,
      async generate() {
        return 'unused';
      },
    },
    plain: {
      async generate() {
        return 'unused';
      },
    },
  },
}).listen();
