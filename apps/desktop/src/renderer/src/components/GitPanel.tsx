import { useEffect, useState } from 'react';
import type { GitOverview } from '@shared/api';
import { changeCounts, useGit } from '../git-store';
import { relativeTime } from '../format';
import { baseName, relativePath } from '../paths';
import { useStore, useT } from '../store';
import { confirmAction, openMenu, promptText, toast, whileVisible } from '../ui';
import { CommitDialog } from './CommitDialog';
import { Icon } from './Icon';

type T = ReturnType<typeof useT>;
const SHOWN = { files: 40, commits: 15 };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
/** M / A / D / ? / U, as a word. */
const statusWord = (t: T, s: string) => t(`git.st.${s.includes('U') ? 'U' : s === '?' ? 'N' : s.includes('A') ? 'A' : s.includes('D') ? 'D' : s.includes('R') ? 'R' : 'M'}` as never);
const statusKey = (s: string) => (s.includes('U') ? 'u' : s === '?' || s.includes('A') ? 'a' : s.includes('D') ? 'd' : 'm');

/**
 * The project's repository in plain words: which branch you're on, what's waiting to go up or
 * come down, what changed and isn't committed yet, who committed what (agents marked), and the
 * agents' own copies. Pull only fast-forwards; nothing here rewrites history.
 */
export function GitPanel() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.activeProjectId));
  const cwd = project?.cwd ?? null;
  const o = useGit((g) => (cwd ? g.byCwd[cwd] : undefined));
  const busy = useGit((g) => (cwd ? g.busy[cwd] : null));
  const load = useGit((g) => g.load);
  const [committing, setCommitting] = useState(false);
  const [all, setAll] = useState({ files: false, commits: false });

  useEffect(() => {
    if (!cwd) return;
    void load(cwd);
    const onFocus = () => void load(cwd);
    window.addEventListener('focus', onFocus);
    const stop = whileVisible(() => void load(cwd), 10_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      stop();
    };
  }, [cwd, load]);

  if (!project || !cwd) return <p className="empty">{t('git.noProject')}</p>;
  if (!o) return <div className="panel-empty"><span className="spin" /></div>;

  const run = async (action: 'fetch' | 'pull' | 'push' | 'switch' | 'branch' | 'init', arg?: string, done?: string) => {
    useGit.setState((g) => ({ busy: { ...g.busy, [cwd]: action } }));
    try {
      await window.alchemist.gitAction(cwd, action, arg);
      if (done) toast(done, undefined, 2500);
    } catch (e) {
      toast(errorText(e));
    } finally {
      useGit.setState((g) => ({ busy: { ...g.busy, [cwd]: null } }));
      await load(cwd);
    }
  };

  if (!o.repo)
    return (
      <div className="git-panel">
        <div className="git-empty">
          <Icon name="branch" size={28} />
          <b>{t('git.noRepo')}</b>
          <p>{t('git.noRepoHint')}</p>
          <button className="btn-send" disabled={!!busy} onClick={() => void run('init', undefined, t('git.initDone'))}>
            {t('git.init')}
          </button>
        </div>
      </div>
    );

  const counts = changeCounts(o);
  const pickBranch = async () => {
    const others = o.branches.filter((b) => !b.current);
    const id = await openMenu([
      ...others.map((b) => ({ id: `s:${b.name}`, label: b.name })),
      ...(others.length ? [{ type: 'separator' as const }] : []),
      { id: 'new', label: `${t('git.newBranch')}…` },
    ]);
    if (id?.startsWith('s:')) await switchTo(id.slice(2));
    if (id === 'new') await newBranch();
  };
  const switchTo = async (name: string) => {
    if (counts.total && !(await confirmAction({ title: t('git.switchTitle', { name }), message: t('git.switchBody', { n: counts.total }), confirmLabel: t('git.switch'), cancelLabel: t('dialog.cancel') }))) return;
    await run('switch', name, t('git.switched', { name }));
  };
  const newBranch = async () => {
    const name = await promptText({ title: t('git.newBranch'), message: t('git.newBranchBody'), placeholder: 'feature/login', confirmLabel: t('git.create'), cancelLabel: t('dialog.cancel') });
    if (name?.trim()) await run('branch', name.trim(), t('git.switched', { name: name.trim() }));
  };
  const sync = o.upstream
    ? o.ahead || o.behind
      ? [o.ahead && t('git.toPush', { n: o.ahead }), o.behind && t('git.toPull', { n: o.behind })].filter(Boolean).join(' · ')
      : t('git.upToDate', { upstream: o.upstream })
    : o.remote
      ? t('git.notPublished')
      : t('git.noRemote');
  const files = all.files ? o.files : o.files.slice(0, SHOWN.files);
  const commits = all.commits ? o.commits : o.commits.slice(0, SHOWN.commits);
  const rel = (p: string) => relativePath(p, o.root ?? cwd) || p;

  return (
    <div className="git-panel">
      <section className="git-head">
        <div className="git-branch-row">
          <button className="git-branch" onClick={() => void pickBranch()} title={t('git.branchTip')} aria-haspopup="menu">
            <Icon name="branch" size={15} />
            <b>{o.detached ? t('git.detached') : (o.branch ?? '—')}</b>
            <Icon name="chevronDown" size={12} />
          </button>
          <button className="icon-btn ic-btn" disabled={!!busy || !o.remote} onClick={() => void run('fetch', undefined, t('git.fetched'))} title={t('git.fetchTip')} aria-label={t('git.fetch')}>
            {busy === 'fetch' ? <span className="spin" /> : <Icon name="refresh" size={14} />}
          </button>
        </div>
        <p className={`git-sync ${o.ahead || o.behind ? 'pending' : ''}`}>
          {sync}
          {o.lastFetch && o.remote ? <small> · {t('git.fetchedAgo', { when: relativeTime(o.lastFetch, locale) })}</small> : null}
        </p>
        <div className="git-actions">
          {o.behind > 0 && (
            <button className="btn-ghost small" disabled={!!busy} onClick={() => void run('pull', undefined, t('git.pulled'))} title={t('git.pullTip')}>
              {busy === 'pull' ? <span className="spin" /> : <Icon name="arrowDown" size={13} />} {t('git.pull', { n: o.behind })}
            </button>
          )}
          {(o.ahead > 0 || (!o.upstream && !!o.remote && !o.detached)) && (
            <button className="btn-send small" disabled={!!busy} onClick={() => void run('push', undefined, t('git.pushed'))} title={o.remote ? t('git.pushTip', { remote: o.remote }) : undefined}>
              {busy === 'push' ? <span className="spin" /> : <Icon name="arrowUp" size={13} />} {o.upstream ? t('git.push', { n: o.ahead }) : t('git.publish')}
            </button>
          )}
        </div>
      </section>

      <section className="git-sec">
        <header>
          <span>
            {t('git.changes')} <em>{counts.total}</em>
          </span>
          {counts.total > 0 && (
            <button className="btn-send small" onClick={() => setCommitting(true)}>
              <Icon name="commit" size={13} /> {t('git.commit')}
            </button>
          )}
        </header>
        {counts.conflicted > 0 && <p className="git-warn">{t('git.conflicts', { n: counts.conflicted })}</p>}
        {counts.total === 0 ? (
          <p className="git-calm">{t('git.clean')}</p>
        ) : (
          <>
            <p className="git-counts">
              {[counts.modified && t('git.nModified', { n: counts.modified }), counts.added && t('git.nAdded', { n: counts.added }), counts.deleted && t('git.nDeleted', { n: counts.deleted })].filter(Boolean).join(' · ')}
            </p>
            <ul className="git-files">
              {files.map((f) => (
                <li key={f.path}>
                  <button className="git-file" disabled={f.status.includes('D')} onClick={() => useStore.getState().openFileAt(project.id, f.path)} title={`${statusWord(t, f.status)} · ${rel(f.path)}`}>
                    <span className={`git-st ${statusKey(f.status)}`}>{f.status === '?' ? 'N' : f.status.slice(0, 1)}</span>
                    <span className="git-file-name">{baseName(f.path)}</span>
                    <small>{rel(f.path).split('/').slice(0, -1).join('/')}</small>
                  </button>
                </li>
              ))}
            </ul>
            {o.files.length > SHOWN.files && (
              <button className="link small" onClick={() => setAll({ ...all, files: !all.files })}>
                {all.files ? t('board.showLess') : t('board.showAll', { n: o.files.length })}
              </button>
            )}
          </>
        )}
      </section>

      <section className="git-sec">
        <header>
          <span>{t('git.history')}</span>
        </header>
        {!commits.length ? (
          <p className="git-calm">{t('git.noCommits')}</p>
        ) : (
          <ol className="git-log">
            {commits.map((c, i) => (
              <li key={c.hash} className={i < o.ahead ? 'unpushed' : ''} title={`${c.short} · ${c.author}`}>
                <span className="git-dot" aria-hidden />
                <div>
                  <span className="git-subject">{c.subject}</span>
                  <small>
                    {relativeTime(c.at, locale)} · {c.author}
                    {c.agent && <span className="git-agent">{t('git.byAgent')}</span>}
                    {i < o.ahead && <span className="git-unpushed">{t('git.notPushed')}</span>}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        )}
        {o.commits.length > SHOWN.commits && (
          <button className="link small" onClick={() => setAll({ ...all, commits: !all.commits })}>
            {all.commits ? t('board.showLess') : t('git.moreCommits')}
          </button>
        )}
      </section>

      <section className="git-sec">
        <header>
          <span>
            {t('git.branches')} <em>{o.branches.length}</em>
          </span>
          <button className="btn-ghost small" onClick={() => void newBranch()}>
            <Icon name="plus" size={12} /> {t('git.newBranch')}
          </button>
        </header>
        <ul className="git-branches">
          {o.branches.map((b) => (
            <li key={b.name}>
              <button className={`git-branch-item ${b.current ? 'current' : ''}`} disabled={b.current || !!busy} onClick={() => void switchTo(b.name)} title={b.current ? t('git.current') : t('git.switchTo', { name: b.name })}>
                {b.current ? <Icon name="check" size={12} /> : <span className="git-branch-pad" />}
                <span className="git-branch-name">{b.name}</span>
                <small>
                  {b.gone ? t('git.gone') : [b.ahead && `${b.ahead}↑`, b.behind && `${b.behind}↓`].filter(Boolean).join(' ') || relativeTime(b.at, locale)}
                </small>
              </button>
            </li>
          ))}
        </ul>
        {o.worktrees.length > 0 && (
          <>
            <h5 className="git-sub">{t('git.copies', { n: o.worktrees.length })}</h5>
            <ul className="git-branches">
              {o.worktrees.map((w) => (
                <li key={w.path} className="git-copy" title={w.path}>
                  <Icon name="folder" size={12} />
                  <span className="git-branch-name">{w.branch ?? baseName(w.path)}</span>
                  <small>{baseName(w.path)}</small>
                </li>
              ))}
            </ul>
          </>
        )}
        {o.stashes > 0 && <p className="git-calm">{t('git.stashes', { n: o.stashes })}</p>}
      </section>
      {committing && <CommitDialog cwd={cwd} changes={new Map(o.files.map((f) => [f.path, f.status]))} onClose={() => setCommitting(false)} onDone={() => void load(cwd)} />}
    </div>
  );
}

/** For the status bar: branch, changes and what's to push, in a few characters. */
export function gitSummary(o: GitOverview | undefined) {
  if (!o?.repo) return null;
  return { branch: o.detached ? 'HEAD' : (o.branch ?? '—'), changes: o.files.length, ahead: o.ahead, behind: o.behind };
}
