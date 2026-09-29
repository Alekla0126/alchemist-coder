import { useId } from 'react';

/**
 * The Alchemist Coder mark: an A (the coordinator on top, agents at the base) bound by a circle,
 * in gold on ink. The same drawing as the app icon and the site's favicon.
 */
export function LogoMark({ size = 20, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} className="logo-mark">
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#211a14" />
          <stop offset="1" stopColor="#0b0a0c" />
        </linearGradient>
        <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="18" y1="10" x2="46" y2="56">
          <stop offset="0" stopColor="#ffe0a8" />
          <stop offset=".4" stopColor="#f0b27a" />
          <stop offset="1" stopColor="#c8653a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}b)`} />
      <g fill="none" stroke={`url(#${id}g)`} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="32" cy="33.5" r="21" strokeWidth="3" />
        <path d="M32 12.5 L13.8 44 L50.2 44 Z" strokeWidth="3.6" />
        <path d="M20.6 32.4 L43.4 32.4" strokeWidth="3.6" />
      </g>
      <g stroke="#120e0b" strokeWidth="1.6" fill={`url(#${id}g)`}>
        <circle cx="32" cy="12.5" r="5.2" fill="#ffe0a8" />
        <circle cx="13.8" cy="44" r="4.2" />
        <circle cx="50.2" cy="44" r="4.2" />
      </g>
    </svg>
  );
}
