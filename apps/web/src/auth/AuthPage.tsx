import { credentialsSchema } from '@app/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/index.js';
import { queryClient } from '../api/query-client.js';
import { safeReturnTo } from './session.js';

export function AuthPage({ register = false }: { register?: boolean }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = safeReturnTo(params.get('returnTo'));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const parsed = credentialsSchema.safeParse({ username, password });
    const errors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
      setFields(errors);
      return;
    }
    setFields({}); setError(''); setPending(true);
    try {
      const user = await (register ? api.signUp(parsed.data) : api.signIn(parsed.data));
      await queryClient.cancelQueries(); queryClient.clear();
      queryClient.setQueryData(['session'], user);
      navigate(returnTo, { replace: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось войти.'); }
    finally { setPending(false); }
  }
  return <section className="auth-card">
    <p className="eyebrow">Личное пространство</p>
    <h1>{register ? 'Создать аккаунт' : 'Вход в Облако'}</h1>
    <p className="muted">Ваши файлы и папки — в одном месте.</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor="username">Имя пользователя</label>
      <input id="username" autoComplete="username" value={username} disabled={pending} onChange={event => setUsername(event.target.value)} aria-invalid={!!fields.username} aria-describedby="username-hint username-error" />
      <small id="username-hint">3–32 символа: латинские строчные буквы, цифры и _</small>
      <p id="username-error" className="field-error">{fields.username}</p>
      <label htmlFor="password">Пароль</label>
      <input id="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} disabled={pending} onChange={event => setPassword(event.target.value)} aria-invalid={!!fields.password} aria-describedby="password-hint password-error" />
      <small id="password-hint">От 8 до 64 символов. Пробелы сохраняются.</small>
      <p id="password-error" className="field-error">{fields.password}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <button className="primary" disabled={pending}>{pending ? 'Подождите…' : register ? 'Зарегистрироваться' : 'Войти'}</button>
    </form>
    <p><Link to={(register ? '/sign-in?' : '/sign-up?') + new URLSearchParams({ returnTo })}>{register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</Link></p>
  </section>;
}
