import { useId } from 'react';

/**
 * The Alchemist Coder mark: a round flask whose bubbles are the agents (the big one is the
 * coordinator), in gold on ink. The same drawing as the app icon and the site's favicon.
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
        <linearGradient id={`${id}g`} gradientUnits="userSpaceOnUse" x1="16" y1="10" x2="46" y2="56">
          <stop offset="0" stopColor="#ffe0a8" />
          <stop offset=".4" stopColor="#f0b27a" />
          <stop offset="1" stopColor="#c8653a" />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <circle cx="32" cy="38.8" r="12.6" />
        </clipPath>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id}b)`} />
      <path clipPath={`url(#${id}c)`} d="M15 42 C21.7 39.6 26.4 44.1 32 42 S41.9 39.8 49 42 V56 H15 Z" fill={`url(#${id}g)`} />
      <path d="M28.6 13 V25 A14.6 14.6 0 1 0 35.4 25 V13" fill="none" stroke={`url(#${id}g)`} strokeWidth="3" strokeLinejoin="round" />
      <path d="M25.2 12.4 H38.8" stroke={`url(#${id}g)`} strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32.6" r="3.1" fill="#ffe0a8" />
      <circle cx="27.2" cy="37.4" r="1.5" fill="#f6c68c" />
    </svg>
  );
}
