import { z } from 'zod';

export const usernameSchema = z.string()
  .min(3, 'Username must contain at least 3 characters')
  .max(32, 'Username must contain at most 32 characters')
  .regex(/^[a-z0-9_]+$/, 'Username may contain only lowercase letters, digits and underscores');

// Не обрезаем пробелы и не меняем регистр: пароль проверяется ровно как введён.
export const passwordSchema = z.string()
  .min(8, 'Password must contain at least 8 characters')
  .max(64, 'Password must contain at most 64 characters');

// Регистрация и вход используют одинаковые правила из раздела 7 ТЗ.
export const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export type Credentials = z.infer<typeof credentialsSchema>;
