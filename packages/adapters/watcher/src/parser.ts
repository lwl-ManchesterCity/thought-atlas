import type { TurnPayload } from '@thought-atlas/core';

export interface ParserSeed {
  state?: unknown;
  reparse?: boolean;
}

export interface TranscriptParser {
  feedLine(line: string): TurnPayload | null;
  snapshot?(): unknown;
}

export interface ParserModule {
  id: string;
  create(path: string, seed?: ParserSeed): TranscriptParser;
}