import { createStorageProvider, type StorageProvider } from "@cre/providers";
import { env } from "./db";

const g = globalThis as unknown as { __creStorage?: StorageProvider };

export function storage(): StorageProvider {
  g.__creStorage ??= createStorageProvider(env());
  return g.__creStorage;
}
