export interface SmartBlock {
  key: string;
  heading: string;
  lines: [number, number];
  embedding: number[];
}

export interface SmartSource {
  path: string;
  embedding: number[];
  blocks: SmartBlock[];
}
