import { RolloutParser, sessionIdFromRolloutPath } from '@thought-atlas/adapter-codex';
import type { ParserModule } from './parser.ts';

export const codexParserModule: ParserModule = {
  id: 'codex',
  create(path) {
    return new RolloutParser({ sessionId: sessionIdFromRolloutPath(path) });
  },
};