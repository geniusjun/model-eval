// A service module that writes to standard output while it is imported.

import console from 'node:console';
import process from 'node:process';

process.stdout.write('written to process.stdout while the service module is imported\n');
console.log('logged while the service module is imported');
