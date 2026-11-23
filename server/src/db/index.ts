/** PostgreSQL 连接池与 Drizzle ORM 实例入口。 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.DATABASE_URL);
export const db = drizzle(sqlClient, { schema });
export * from "./schema.ts";

void sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint NOT NULL DEFAULT 0`.catch(() => undefined);
void sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_expires_at timestamptz`.catch(() => undefined);
void sqlClient`ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb`.catch(() => undefined);
