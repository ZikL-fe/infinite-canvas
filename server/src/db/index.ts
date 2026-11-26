/** PostgreSQL 连接池与 Drizzle ORM 实例入口。 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env.ts";
import * as schema from "./schema.ts";

export const sqlClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT_SECONDS,
  connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
});
export const db = drizzle(sqlClient, { schema });
export * from "./schema.ts";

let schemaReadyPromise: Promise<void> | null = null;

/** 启动时幂等建表并补齐增量表结构与字段，确保全新空库与旧库均可直接启动。 */
export function ensureSchemaReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const statements = [
        sqlClient`
          CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text NOT NULL UNIQUE,
            email text UNIQUE,
            email_verified_at timestamptz,
            password_hash text NOT NULL,
            display_name text NOT NULL,
            avatar_url text NOT NULL DEFAULT '',
            role text NOT NULL DEFAULT 'user',
            status text NOT NULL DEFAULT 'active',
            storage_used_bytes bigint NOT NULL DEFAULT 0,
            storage_quota_bytes bigint NOT NULL DEFAULT 0,
            storage_quota_expires_at timestamptz,
            storage_pre_expiry_warned_for timestamptz,
            storage_expired_warned_for timestamptz,
            storage_cleaned_at timestamptz,
            webdav_config jsonb,
            low_balance_alert_enabled boolean,
            low_balance_threshold double precision,
            low_balance_alerted_at timestamptz,
            invite_code text UNIQUE,
            invited_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
            last_login_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS plans (
            id text PRIMARY KEY,
            code text NOT NULL UNIQUE,
            name text NOT NULL,
            description text NOT NULL DEFAULT '',
            price_cents integer NOT NULL DEFAULT 0,
            duration_days integer,
            storage_quota_bytes bigint NOT NULL DEFAULT 0,
            monthly_credits integer NOT NULL DEFAULT 0,
            features jsonb NOT NULL DEFAULT '{}'::jsonb,
            is_default boolean NOT NULL DEFAULT false,
            is_active boolean NOT NULL DEFAULT true,
            sort_order integer NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS user_sessions (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            refresh_token_hash text NOT NULL,
            user_agent text NOT NULL DEFAULT '',
            ip text NOT NULL DEFAULT '',
            expires_at timestamptz NOT NULL,
            revoked_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS media_objects (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            bucket text NOT NULL,
            object_key text NOT NULL UNIQUE,
            kind text NOT NULL DEFAULT 'file',
            mime_type text NOT NULL DEFAULT 'application/octet-stream',
            bytes bigint NOT NULL DEFAULT 0,
            width integer,
            height integer,
            duration_ms integer,
            source_type text NOT NULL DEFAULT 'upload',
            status text NOT NULL DEFAULT 'pending',
            meta jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS user_assets (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind text NOT NULL,
            title text NOT NULL,
            media_id text REFERENCES media_objects(id) ON DELETE SET NULL,
            cover_url text NOT NULL DEFAULT '',
            tags jsonb NOT NULL DEFAULT '[]'::jsonb,
            note text,
            source text,
            data jsonb NOT NULL DEFAULT '{}'::jsonb,
            deleted_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS canvas_projects (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title text NOT NULL,
            nodes jsonb NOT NULL DEFAULT '[]'::jsonb,
            connections jsonb NOT NULL DEFAULT '[]'::jsonb,
            chat_sessions jsonb NOT NULL DEFAULT '[]'::jsonb,
            active_chat_id text,
            background_mode text NOT NULL DEFAULT 'lines',
            show_image_info boolean NOT NULL DEFAULT false,
            viewport jsonb NOT NULL DEFAULT '{"x":0,"y":0,"k":1}'::jsonb,
            version integer NOT NULL DEFAULT 1,
            deleted_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS system_settings (
            key text PRIMARY KEY,
            value jsonb NOT NULL DEFAULT '{}'::jsonb,
            encrypted_secret text,
            updated_by text REFERENCES users(id) ON DELETE SET NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS user_subscriptions (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            plan_id text NOT NULL REFERENCES plans(id),
            status text NOT NULL DEFAULT 'active',
            started_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS credit_wallets (
            user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            balance double precision NOT NULL DEFAULT 0,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS credit_ledger (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            delta double precision NOT NULL,
            balance_after double precision NOT NULL,
            reserved_credits double precision NOT NULL DEFAULT 0,
            reservation_expires_at timestamptz,
            reason text NOT NULL,
            ref_id text,
            meta jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS ai_billing_tasks (
            id text PRIMARY KEY,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel_id text NOT NULL,
            model text NOT NULL,
            task_id text NOT NULL UNIQUE,
            charged_credits double precision NOT NULL DEFAULT 0,
            status text NOT NULL DEFAULT 'pending',
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS redeem_codes (
            id text PRIMARY KEY,
            code text NOT NULL UNIQUE,
            name text NOT NULL DEFAULT '',
            kind text NOT NULL DEFAULT 'credits',
            credits double precision NOT NULL DEFAULT 0,
            storage_quota_bytes bigint NOT NULL DEFAULT 0,
            storage_duration_days integer,
            max_uses integer NOT NULL DEFAULT 1,
            used_count integer NOT NULL DEFAULT 0,
            note text NOT NULL DEFAULT '',
            status text NOT NULL DEFAULT 'active',
            expires_at timestamptz,
            created_by text REFERENCES users(id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`
          CREATE TABLE IF NOT EXISTS redeem_records (
            id text PRIMARY KEY,
            code_id text NOT NULL REFERENCES redeem_codes(id) ON DELETE CASCADE,
            user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind text NOT NULL DEFAULT 'credits',
            credits double precision NOT NULL DEFAULT 0,
            storage_quota_bytes bigint NOT NULL DEFAULT 0,
            storage_duration_days integer,
            storage_expires_at_after timestamptz,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`CREATE UNIQUE INDEX IF NOT EXISTS redeem_records_code_user_idx ON redeem_records (code_id, user_id)`,
        sqlClient`
          CREATE TABLE IF NOT EXISTS announcements (
            id text PRIMARY KEY,
            title text NOT NULL,
            content text NOT NULL,
            level text NOT NULL DEFAULT 'default',
            is_pinned boolean NOT NULL DEFAULT false,
            is_published boolean NOT NULL DEFAULT true,
            created_by text REFERENCES users(id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
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
        sqlClient`ALTER TABLE redeem_codes ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT ''`,
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
        sqlClient`ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS reserved_credits double precision NOT NULL DEFAULT 0`,
        sqlClient`ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz`,
        sqlClient`CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS media_objects_user_status_created_idx ON media_objects (user_id, status, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS user_assets_user_updated_idx ON user_assets (user_id, updated_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS canvas_projects_user_updated_idx ON canvas_projects (user_id, updated_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS workbench_logs_user_kind_updated_idx ON workbench_logs (user_id, kind, updated_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS workbench_logs_user_created_idx ON workbench_logs (user_id, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS credit_ledger_user_created_idx ON credit_ledger (user_id, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS credit_ledger_created_idx ON credit_ledger (created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS credit_ledger_reservations_idx ON credit_ledger (user_id, reservation_expires_at) WHERE reserved_credits > 0`,
        sqlClient`CREATE INDEX IF NOT EXISTS ai_billing_tasks_user_created_idx ON ai_billing_tasks (user_id, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS media_objects_user_client_task_idx ON media_objects (user_id, (meta->>'clientTaskId')) WHERE meta ? 'clientTaskId'`,
        sqlClient`CREATE INDEX IF NOT EXISTS media_objects_user_video_task_idx ON media_objects (user_id, (meta->>'videoTaskId')) WHERE meta ? 'videoTaskId'`,
        sqlClient`CREATE INDEX IF NOT EXISTS credit_ledger_user_client_task_idx ON credit_ledger (user_id, (meta->>'clientTaskId')) WHERE meta ? 'clientTaskId'`,
        sqlClient`CREATE INDEX IF NOT EXISTS credit_ledger_user_task_id_idx ON credit_ledger (user_id, (meta->>'taskId')) WHERE meta ? 'taskId'`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code text UNIQUE`,
        sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id text REFERENCES users(id) ON DELETE SET NULL`,
        sqlClient`CREATE INDEX IF NOT EXISTS users_invited_by_idx ON users (invited_by_user_id)`,
        sqlClient`
          CREATE TABLE IF NOT EXISTS invite_rebate_records (
            id text PRIMARY KEY,
            inviter_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            invitee_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            source_ledger_id text NOT NULL UNIQUE,
            source_reason text NOT NULL,
            source_amount double precision NOT NULL,
            rebate_percent double precision NOT NULL,
            rebate_credits double precision NOT NULL,
            reclaimed_source_amount double precision NOT NULL DEFAULT 0,
            reclaimed_credits double precision NOT NULL DEFAULT 0,
            inviter_ledger_id text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `,
        sqlClient`CREATE INDEX IF NOT EXISTS invite_rebate_records_inviter_idx ON invite_rebate_records (inviter_user_id, created_at DESC)`,
        sqlClient`CREATE INDEX IF NOT EXISTS invite_rebate_records_invitee_idx ON invite_rebate_records (invitee_user_id, created_at DESC)`,
      ];
      try {
        for (const stmt of statements) {
          await stmt;
        }
      } catch (err) {
        schemaReadyPromise = null;
        console.error("[db] schema bootstrap failed:", err);
        throw err;
      }
    })();
  }
  return schemaReadyPromise;
}
