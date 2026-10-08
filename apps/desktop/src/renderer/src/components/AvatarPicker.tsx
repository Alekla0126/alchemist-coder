import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import type { BotConfig } from '@shared/api';
import { AVATAR_EMOJI, chooseImage, resizeImage } from '../avatar';
import { monsterUri, newMonsterSeed } from '../monster';
import { useStore, useT } from '../store';
import { toast } from '../ui';
import { AgentAvatar } from './AgentAvatar';

/** The agent whose picture is being chosen (null: the picker is closed). */
export const useAvatarPicker = create<{ member: BotConfig | null }>(() => ({ member: null }));

const MONSTERS = 11;
const seeds = () => Array.from({ length: MONSTERS }, newMonsterSeed);
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

/**
 * Choosing an agent's picture: its own monster (drawn from its name) or another one, one of the app's
 * emoji, or an image of yours. A monster is kept by its seed, so renaming the agent doesn't change it.
 */
export function AvatarPicker() {
  const t = useT();
  const member = useAvatarPicker((s) => s.member);
  const [options, setOptions] = useState(seeds);
  const close = () => useAvatarPicker.setState({ member: null });
  useEffect(() => {
    if (!member) return;
    setOptions(seeds());
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [member]);
  if (!member) return null;
  const save = async (avatar: string | null) => {
    close();
    try {
      await window.alchemist.saveBotConfig({ ...member, avatar });
      await useStore.getState().loadBots();
    } catch (e) {
      toast(errorText(e));
    }
  };
  const upload = async () => {
    const file = await chooseImage();
    if (!file) return;
    try {
      await save(await resizeImage(file));
    } catch {
      toast(t('avatar.unreadable'));
    }
  };
  const own = member.name.trim();
  const current = member.avatar ?? `monster:${own}`;
  const tile = (value: string, content: ReactNode, label: string) => (
    <button key={value} className={`av-tile ${current === value ? 'on' : ''}`} onClick={() => void save(value)} title={label} aria-label={label} aria-pressed={current === value}>
      {content}
    </button>
  );
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog av-picker" role="dialog" aria-label={t('avatar.change')}>
        <div className="av-picker-head">
          <AgentAvatar name={member.name} avatar={member.avatar} size={44} />
          <div>
            <h3>{t('avatar.change')}</h3>
            <p>{member.name}</p>
          </div>
        </div>
        <div className="av-section">
          <b>{t('avatar.monsters')}</b>
          <button className="btn-ghost small" onClick={() => setOptions(seeds())}>
            ↻ {t('avatar.moreMonsters')}
          </button>
        </div>
        <div className="av-grid">
          {own && tile(`monster:${own}`, <img src={monsterUri(own)} alt="" draggable={false} />, t('avatar.ownMonster'))}
          {options.map((seed) => tile(`monster:${seed}`, <img src={monsterUri(seed)} alt="" draggable={false} />, t('avatar.monster')))}
        </div>
        <div className="av-section">
          <b>{t('avatar.pick')}</b>
        </div>
        <div className="av-grid av-emoji">{AVATAR_EMOJI.map((e) => tile(`emoji:${e}`, <span>{e}</span>, e))}</div>
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={() => void upload()}>
            {t('avatar.upload')}…
          </button>
          <span className="composer-sp" />
          <button className="btn-ghost" onClick={close}>
            {t('dialog.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
