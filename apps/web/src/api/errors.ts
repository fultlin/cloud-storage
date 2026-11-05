export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export function apiErrorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message)) {
      const lines = message.filter((item): item is string => typeof item === 'string' && !!item.trim());
      if (lines.length) return lines.join('\n');
    }
  }
  const fallback: Record<number, string> = {
    400: 'Проверьте введённые данные.', 401: 'Необходимо войти в аккаунт.',
    404: 'Ресурс не найден.', 409: 'Ресурс с таким именем уже существует.',
    500: 'Ошибка сервера. Попробуйте ещё раз.',
  };
  return fallback[status] ?? 'Не удалось выполнить запрос.';
}
