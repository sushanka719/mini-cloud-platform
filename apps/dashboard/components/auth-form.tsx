'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type AuthResponse } from '@/lib/api';
import { Button, ErrorNote, Field, Input } from '@/components/ui/primitives';

/**
 * Login and register share everything but two fields, so they share a
 * component. The session arrives as an httpOnly cookie the browser stores
 * automatically — nothing token-shaped is kept in JS.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  const router = useRouter();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const body = isRegister
        ? { email, name, password, ...(orgName.trim() ? { orgName: orgName.trim() } : {}) }
        : { email, password };
      const result = await api.post<AuthResponse>(`/auth/${mode}`, body);
      // Seed the cache so the next screen renders without a round trip.
      queryClient.setQueryData(['session'], {
        user: result.user,
        orgs: result.orgs,
        via: 'session',
      });
      const first = result.orgs[0];
      router.push(first ? `/orgs/${first.slug}` : '/');
      router.refresh();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">ForgeCloud</h1>
        <p className="mt-1 text-sm text-[#8b90a3]">
          {isRegister ? 'Create your account' : 'Sign in to your account'}
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-xl border border-[#232734] bg-[#11131b] p-6"
      >
        <Field label="Email">
          <Input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        {isRegister && (
          <>
            <Field label="Name">
              <Input
                required
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada Lovelace"
              />
            </Field>
            <Field label="Organization" hint="Optional — defaults to “<your name>’s org”.">
              <Input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Inc"
              />
            </Field>
          </>
        )}

        <Field label="Password" hint={isRegister ? 'At least 10 characters.' : undefined}>
          <Input
            type="password"
            required
            minLength={isRegister ? 10 : undefined}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
          />
        </Field>

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
        </Button>

        <ErrorNote error={error} />
      </form>

      <p className="mt-6 text-center text-sm text-[#8b90a3]">
        {isRegister ? 'Already have an account? ' : 'No account yet? '}
        <Link
          href={isRegister ? '/login' : '/register'}
          className="text-emerald-400 hover:underline"
        >
          {isRegister ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </main>
  );
}
