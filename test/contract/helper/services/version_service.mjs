// An adapter that reports the version of the folder `MODEL_EVAL_SERVICE_DIR` names, or no
// `serviceDir` when the variable is unset (data-model §Service Version).

import { helperExport } from './support.mjs';

import process from 'node:process';

const serviceDir = process.env.MODEL_EVAL_SERVICE_DIR;

helperExport('defineAdapter')({
  name: 'version-service',
  version: '0.0.1',
  ...(serviceDir === undefined ? {} : { serviceDir }),
  targets: {
    chat: {
      languages: ['en'],
      generate() {
        return 'unused';
      },
    },
  },
}).listen();
