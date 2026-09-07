'use client';

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { ApiError } from '@/lib/api';

/** Small shared UI vocabulary so every screen looks like the same product. */

export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-[#232734] bg-[#11131b] ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-[#232734] px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-xs text-[#8b90a3]">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
};

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  const styles: Record<string, string> = {
    primary: 'bg-emerald-500 text-[#08090d] hover:bg-emerald-400 disabled:bg-emerald-500/40',
    secondary:
      'border border-[#2c3142] bg-[#171a24] text-[#e6e8ef] hover:border-[#3a4056] disabled:opacity-50',
    danger: 'border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 disabled:opacity-50',
    ghost: 'text-[#8b90a3] hover:text-[#e6e8ef] disabled:opacity-50',
  };
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-[#8b90a3]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-[#6e7387]">{hint}</span>}
    </label>
  );
}

const controlClass =
  'w-full rounded-lg border border-[#2c3142] bg-[#0d0f16] px-3 py-2 text-sm text-[#e6e8ef] placeholder:text-[#575c70] outline-none focus:border-emerald-500/60';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${controlClass} ${className}`} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${controlClass} ${className}`} />;
}

/** Renders an API error with its server-side code, so RBAC denials are legible. */
export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const isApi = error instanceof ApiError;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {message}
      {isApi && (
        <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 font-mono text-[10px] uppercase">
          {error.code}
        </span>
      )}
    </p>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const tone: Record<string, string> = {
    owner: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    admin: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    member: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    viewer: 'border-[#3a4056] bg-[#1a1e2a] text-[#8b90a3]',
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone[role] ?? tone.viewer}`}
    >
      {role}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[#6e7387]">{children}</p>;
}
