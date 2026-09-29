import { useEffect, useRef, useState } from 'react';
import { useUi } from '../ui';

function Dialog() {
  const dialog = useUi((s) => s.dialog);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!dialog) return;
    setValue(dialog.input ?? '');
    requestAnimationFrame(() => {
      if (dialog.input !== undefined) {
        input.current?.focus();
        input.current?.select();
      } else if (dialog.danger) cancelBtn.current?.focus(); // Enter must never destroy by accident
      else confirmBtn.current?.focus();
    });
  }, [dialog]);
  if (!dialog) return null;
  const submit = () => dialog.resolve(dialog.input !== undefined ? value : true);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dialog.resolve(null)}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') dialog.resolve(null);
          if (e.key === 'Enter' && dialog.input !== undefined) submit();
        }}
      >
        <h3>{dialog.title}</h3>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.input !== undefined && <input ref={input} value={value} placeholder={dialog.placeholder} onChange={(e) => setValue(e.target.value)} />}
        <div className="dialog-actions">
          <button ref={cancelBtn} className="btn-ghost" onClick={() => dialog.resolve(null)}>
            {dialog.cancelLabel}
          </button>
          <button ref={confirmBtn} className={dialog.danger ? 'btn-danger' : 'btn-send'} onClick={submit}>
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast() {
  const toast = useUi((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      {toast.text}
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.run();
            useUi.setState({ toast: null });
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/** Dialogs and toasts, above everything else. */
export function Overlays() {
  return (
    <>
      <Dialog />
      <Toast />
    </>
  );
}
