import { api, json } from './api';
import type { Quote } from './quote';

/** The live demo's API. The server keeps the sample businesses and their prices. */
export interface DemoTurn {
  reply: string;
  chips: string[];
  askPhoto: boolean;
  ready: boolean;
  serviceName: string;
}
export interface DemoChatInput {
  tradeId: string;
  pass: string;
  serviceName: string;
  messages: { from: 'customer' | 'assistant'; text: string }[];
}

export const startDemoChat = (headers: Record<string, string>) =>
  api<{ pass: string }>('/demo/start', { method: 'POST', headers, ...json({}) });
export const requestDemoTurn = (input: DemoChatInput) =>
  api<DemoTurn>('/demo/turn', { method: 'POST', ...json(input) });
export const requestDemoQuote = (input: DemoChatInput) =>
  api<{ quote: Quote | null; visit: string | null }>('/demo/quote', {
    method: 'POST',
    ...json(input),
  });
