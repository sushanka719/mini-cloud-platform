import { getDb, type User } from '@forge/db';

export async function findUserByEmail(email: string): Promise<User | undefined> {
  // `email` is citext, so this compares case-insensitively in the database.
  return getDb().selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
}

export async function findUserById(id: string): Promise<User | undefined> {
  return getDb().selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function insertUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<User> {
  return getDb()
    .insertInto('users')
    .values({ email: input.email, name: input.name, password_hash: input.passwordHash })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  await getDb()
    .updateTable('users')
    .set({ password_hash: passwordHash })
    .where('id', '=', id)
    .execute();
}
