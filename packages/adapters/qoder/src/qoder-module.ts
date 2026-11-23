import type { ParserModule } from '@thought-atlas/adapter-watcher';
import { QoderParser, qoderSessionIdFromPath } from './qoder-parser.ts';

export const qoderParserModule: ParserModule = {
  id: 'qoder',
  create(path, seed) {
    return new QoderParser({
      sessionId: qoderSessionIdFromPath(path),
      state: seed?.state,
      reparse: seed?.reparse,
    });
  },
};