import type { AlchemistApi } from '@shared/api';

declare global {
  interface Window {
    alchemist: AlchemistApi;
  }
}
