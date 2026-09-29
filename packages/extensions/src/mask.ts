const SECRET_NAME = /(key|token|secret|password|passwd|pwd|auth|bearer|credential|cookie|session|sig)/i;
const SECRET_FLAG = new RegExp(`^--?[\\w-]*${SECRET_NAME.source}[\\w-]*$`, 'i');
const SECRET_ASSIGN = new RegExp(`^(--?[\\w-]*${SECRET_NAME.source}[\\w-]*)=.+$`, 'i');
const TOKENISH = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-.+/=]{24,}$/;
const ENV_FLAG = /^(-e|--env)$/;
const HEADER_FLAG = /^(-H|--header)$/;

/** Hides credentials in URLs: user:pass@ and secret-looking query parameters. */
export function maskUrl(url: string): string {
  return url
    .replace(/(\/\/)[^/@\s]*:[^/@\s]*@/, '$1•••@')
    .replace(new RegExp(`([?&][^=&]*${SECRET_NAME.source}[^=&]*=)[^&#]*`, 'gi'), '$1•••');
}

/** Arguments with the values of secret-looking flags, env/header values and bare tokens hidden. */
export function maskArgs(args: string[]): string[] {
  return args.map((a, i) => {
    const prev = args[i - 1] ?? '';
    if (ENV_FLAG.test(prev)) return a.replace(/=.*/s, '=•••');
    if (HEADER_FLAG.test(prev)) return a.replace(/:.*/s, ': •••');
    if (SECRET_FLAG.test(prev) && !a.startsWith('-')) return '•••';
    const m = SECRET_ASSIGN.exec(a);
    if (m) return `${m[1]}=•••`;
    if (/^[a-z][\w+.-]*:\/\//i.test(a)) return maskUrl(a);
    return TOKENISH.test(a) ? '•••' : a;
  });
}

/** A shell command line (e.g. a hook) with the same masking applied word by word. */
export function maskCommand(command: string): string {
  const parts = command.split(/(\s+)/);
  const words = parts.filter((_, i) => i % 2 === 0);
  const masked = maskArgs(words.map((w) => w.replace(/^["']|["']$/g, '')));
  return parts
    .map((p, i) => (i % 2 ? p : masked[i / 2] === words[i / 2]!.replace(/^["']|["']$/g, '') ? p : masked[i / 2]))
    .join('')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1•••');
}

/** Replaces every literal secret in `text` (values shorter than 4 characters are left alone). */
export function scrub(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('•••');
  return out.replace(/(Bearer\s+)[^\s"',}]+/gi, '$1•••').replace(/(\/\/)[^/@\s"]*:[^/@\s"]*@/g, '$1•••@');
}
