import { ReactNode } from 'react';
import { X } from 'lucide-react';

export function Badge({ tone = 'gray', children }: { tone?: 'gray' | 'teal' | 'orange' | 'red' | 'violet' | 'blue'; children: ReactNode }) {
  return <i className={`badge tone-${tone}`}>{children}</i>;
}

export function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ width }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export const inputCls = 'ui-input';
