import type { RendererApi } from '../common/types';

declare global {
  interface Window {
    ewWeidian: RendererApi;
  }
}

export {};
