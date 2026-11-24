/** PostgreSQL 连接池与 Drizzle ORM 实例入口。 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.DATABASE_URL);
export const db = drizzle(sqlClient, { schema });
export * from "./schema.ts";

let schemaReadyPromise: Promise<void> | null = null;

/** 启动时幂等补齐增量表结构与字段，避免旧库未执行 db:push 时报错。 */
export function ensureSchemaReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const statements = [
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint NOT NULL DEFAULT 0`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_expires_at timestamptz`,
        sqlClient`ALTER TABLE media_objects ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb`,
        sqlClient`
          CREATE TABLE IF NOT EXISTS workbench_logs (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind text NOT NULL,
            title text NOT NULL DEFAULT '',
            prompt text NOT NULL DEFAULT '',
            model text NOT NULL DEFAULT '',
            status text NOT NULL DEFAULT 'success',
            duration_ms integer NOT NULL DEFAULT 0,
            payload jsonb NOT NULL DEFAULT '{}'::jsonb,
            deleted_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'credits'`,
        sqlClient`ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint NOT NULL DEFAULT 0`,
        sqlClient`ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS storage_duration_days integer`,
        sqlClient`ALTER TABLE redeem_records ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'credits'`,
        sqlClient`ALTER TABLE redeem_records ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint NOT NULL DEFAULT 0`,
        sqlClient`ALTER TABLE redeem_records ADD COLUMN IF NOT EXISTS storage_duration_days integer`,
        sqlClient`ALTER TABLE redeem_records ADD COLUMN IF NOT EXISTS storage_expires_at_after timestamptz`,
        sqlClient`
          CREATE TABLE IF NOT EXISTS user_storage_grants (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            quota_bytes bigint NOT NULL DEFAULT 0,
            duration_days integer,
            expires_at timestamptz,
            source text NOT NULL DEFAULT 'redeem_code',
            ref_id text,
            code_id text REFERENCES redeem_codes(id) ON DELETE SET NULL,
            note text NOT NULL DEFAULT '',
            status text NOT NULL DEFAULT 'active',
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`CREATE INDEX IF NOT EXISTS user_storage_grants_user_idx ON user_storage_grants (user_id, created_at DESC)`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS low_balance_alert_enabled boolean`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS low_balance_threshold double precision`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS low_balance_alerted_at timestamptz`,
        sqlClient`
          CREATE TABLE IF NOT EXISTS email_verification_codes (
            id text PRIMARY KEY,
            email text NOT NULL,
            purpose text NOT NULL,
            user_id text REFERENCES users(id) ON DELETE CASCADE,
            code_hash text NOT NULL,
            attempts integer NOT NULL DEFAULT 0,
            expires_at timestamptz NOT NULL,
            consumed_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`CREATE INDEX IF NOT EXISTS email_verification_codes_lookup_idx ON email_verification_codes (email, purpose, created_at DESC)`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_pre_expiry_warned_for timestamptz`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_expired_warned_for timestamptz`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_cleaned_at timestamptz`,
      ];
      for (const stmt of statements) {
        await stmt.catch((err) => {
          console.warn("[db] schema bootstrap statement failed:", err);
        });
      }
    })();
  }
  return schemaReadyPromise;
}

void ensureSchemaReady();
