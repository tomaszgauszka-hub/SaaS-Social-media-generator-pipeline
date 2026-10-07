import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@cre/config";
import { PrismaClient, type Prisma } from "./generated/prisma/client.ts";

export type TxClient = Prisma.TransactionClient;
/** Either the root client or an interactive-transaction client. Services accept this to compose transactions. */
export type DbClient = PrismaClient | TxClient;

export interface CreatePrismaOptions {
  url?: string;
  poolSize?: number;
  log?: Prisma.LogLevel[];
}

export function createPrismaClient(opts: CreatePrismaOptions = {}): PrismaClient {
  const connectionString = opts.url ?? getEnv().DATABASE_URL;
  const adapter = new PrismaPg({ connectionString, max: opts.poolSize ?? 10 });
  return new PrismaClient({ adapter, log: opts.log ?? ["warn", "error"] });
}

const globalForPrisma = globalThis as unknown as { __crePrisma?: PrismaClient };

/** Process-wide client (cached on globalThis so Next.js dev hot-reload does not exhaust connections). */
export function getPrisma(): PrismaClient {
  globalForPrisma.__crePrisma ??= createPrismaClient();
  return globalForPrisma.__crePrisma;
}

/** Replace the process-wide client (tests use a dedicated database). */
export function setPrisma(client: PrismaClient): void {
  globalForPrisma.__crePrisma = client;
}

/** Interactive-transaction clients have no `$transaction` method. */
export function isTransactionClient(db: DbClient): boolean {
  return !("$transaction" in db);
}

/**
 * Run `fn` inside a transaction. If `db` already is a transaction client, `fn` joins it
 * (Prisma interactive transactions cannot be nested).
 */
export async function inTransaction<T>(
  db: DbClient,
  fn: (tx: TxClient) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!("$transaction" in db)) return fn(db);
  return (db as PrismaClient).$transaction(fn, { timeout: opts.timeoutMs ?? 15_000, maxWait: 10_000 });
}
