import type { MarketingBrand } from './api';

/** The brand as a short document an agent reads before writing anything. */
export function brandMarkdown(brand: MarketingBrand): string {
  const row = (label: string, value: string) => (value.trim() ? `**${label}:** ${value.trim()}\n\n` : '');
  return (
    `# Brand guide${brand.product.trim() ? ` — ${brand.product.trim()}` : ''}\n\n` +
    '> Written by Alchemist Coder (Marketing mode). Read it before writing anything for this project.\n\n' +
    row('What it is', brand.pitch) +
    row('For', brand.audience) +
    row('Voice and tone', brand.tone) +
    row('Say', brand.say) +
    row('Avoid', brand.avoid) +
    row('Claims we can make (only these; never invent features, numbers, reviews, anecdotes or company history)', brand.claims) +
    row('Links', brand.links) +
    row('Languages', brand.languages)
  );
}
