import { ConflictException, Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { Prisma, type User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Хеш не выходит из сервиса: будущая авторизация получит только id и username.
export type AuthenticatedUser = Pick<User, 'id' | 'username'>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: number): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true },
    });
  }

  async create(username: string, password: string): Promise<AuthenticatedUser> {
    // Argon2 сам создаёт случайную соль и включает её в строку хеша.
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    try {
      return await this.prisma.user.create({
        data: { username, passwordHash },
        select: { id: true, username: true },
      });
    } catch (error: unknown) {
      // Индекс БД защищает и от двух одновременных регистраций одного имени.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Username is already taken');
      }
      // Неожиданные ошибки обработает Nest, без передачи деталей клиенту.
      throw error;
    }
  }

  async verifyCredentials(username: string, password: string): Promise<AuthenticatedUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, passwordHash: true },
    });

    // Одинаковый результат для неизвестного имени и неверного пароля.
    if (!user || !(await verify(user.passwordHash, password))) {
      return null;
    }

    return { id: user.id, username: user.username };
  }
}
