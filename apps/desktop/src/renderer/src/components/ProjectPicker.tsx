import { useEffect, useMemo, useRef, useState } from 'react';
import { initials, projectGradient, relativeTime } from '../format';
import { useStore, useT } from '../store';

export function ProjectPicker() {
  const t = useT();
  const locale = useStore((s) => s.locale);
  const projects = useStore((s) => s.projects);
  const openProject = useStore((s) => s.openProject);
  const setPickerOpen = useStore((s) => s.setPickerOpen);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? projects.filter((p) => p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle)) : projects;
  }, [projects, q]);
  return (
    <div className="overlay" onMouseDown={() => setPickerOpen(false)}>
      <div className="picker" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="picker-input"
          placeholder={t('projects.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPickerOpen(false);
            if (e.key === 'Enter' && list[0]) void openProject(list[0].id);
          }}
        />
        <div className="picker-list">
          {list.length === 0 && <p className="empty">{t('projects.none')}</p>}
          {list.map((p) => (
            <button key={p.id} className="picker-row" onClick={() => void openProject(p.id)}>
              <span className="avatar" style={{ background: projectGradient(p.name) }}>{initials(p.name)}</span>
              <span className="picker-main">
                <b>{p.name}</b>
                <small>{p.cwd}</small>
              </span>
              <span className="picker-meta">
                {t('projects.sessions', { n: p.sessionCount })}
                <small>{relativeTime(p.lastTs, locale)}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
