import { parentPort, workerData } from 'node:worker_threads';
import { parseSegmentation } from './sam-parse.js';

/** Reads one SAM answer off the API's main thread (meta-media.ts, parseOffThread). */
parentPort!.postMessage(await parseSegmentation(String(workerData)));
