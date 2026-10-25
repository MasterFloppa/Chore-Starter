import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Dialog({ title, onClose, children, busy = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = 'active-dialog-title';
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); };
  }, []);

  return (
    <dialog ref={ref} aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
      </div>
      {children}
    </dialog>
  );
}
