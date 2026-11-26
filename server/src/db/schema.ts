/** 数据库表结构定义：用户、会话、对象存储媒体、素材、画布、系统配置、钱包账本、视频计费任务、兑换码及平台公告。 */
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';
export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export type MediaStatus = 'pending' | 'active' | 'deleted';
export type WorkbenchKind = 'image' | 'video';

export type UserWebdavConfig = {
  enabled: boolean;
  url?: string;
  username?: string;
  password?: string;
  directory?: string;
  quotaBytes?: number | null;
  usedBytes?: number;
  expiresAt?: string | null;
};

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email').unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url').notNull().default(''),
  role: text('role').$type<UserRole>().notNull().default('user'),
  status: text('status').$type<UserStatus>().notNull().default('active'),
  storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' })
    .notNull()
    .default(0),
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
    .notNull()
    .default(0),
  storageQuotaExpiresAt: timestamp('storage_quota_expires_at', {
    withTimezone: true,
  }),
  storagePreExpiryWarnedFor: timestamp('storage_pre_expiry_warned_for', {
    withTimezone: true,
  }),
  storageExpiredWarnedFor: timestamp('storage_expired_warned_for', {
    withTimezone: true,
  }),
  storageCleanedAt: timestamp('storage_cleaned_at', { withTimezone: true }),
  webdavConfig: jsonb('webdav_config').$type<UserWebdavConfig | null>(),
  lowBalanceAlertEnabled: boolean('low_balance_alert_enabled'),
  lowBalanceThreshold: doublePrecision('low_balance_threshold'),
  lowBalanceAlertedAt: timestamp('low_balance_alerted_at', {
    withTimezone: true,
  }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userSessions = pgTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('user_sessions_user_idx').on(table.userId, table.createdAt)],
);

export const mediaObjects = pgTable(
  'media_objects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull().unique(),
    kind: text('kind').$type<MediaKind>().notNull().default('file'),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    sourceType: text('source_type').notNull().default('upload'),
    status: text('status').$type<MediaStatus>().notNull().default('pending'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('media_objects_user_status_created_idx').on(
      table.userId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const userAssets = pgTable(
  'user_assets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    mediaId: text('media_id').references(() => mediaObjects.id, {
      onDelete: 'set null',
    }),
    coverUrl: text('cover_url').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    note: text('note'),
    source: text('source'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_assets_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);

export const canvasProjects = pgTable(
  'canvas_projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    nodes: jsonb('nodes').$type<unknown[]>().notNull().default([]),
    connections: jsonb('connections').$type<unknown[]>().notNull().default([]),
    chatSessions: jsonb('chat_sessions').$type<unknown[]>().notNull().default([]),
    activeChatId: text('active_chat_id'),
    backgroundMode: text('background_mode').notNull().default('lines'),
    showImageInfo: boolean('show_image_info').notNull().default(false),
    viewport: jsonb('viewport')
      .$type<{ x: number; y: number; k: number }>()
      .notNull()
      .default({ x: 0, y: 0, k: 1 }),
    version: integer('version').notNull().default(1),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('canvas_projects_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);

export const workbenchLogs = pgTable(
  'workbench_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<WorkbenchKind>().notNull(),
    title: text('title').notNull().default(''),
    prompt: text('prompt').notNull().default(''),
    model: text('model').notNull().default(''),
    status: text('status').notNull().default('success'),
    durationMs: integer('duration_ms').notNull().default(0),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('workbench_logs_user_kind_updated_idx').on(
      table.userId,
      table.kind,
      table.updatedAt,
    ),
    index('workbench_logs_user_created_idx').on(table.userId, table.createdAt),
  ],
);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  encryptedSecret: text('encrypted_secret'),
  updatedBy: text('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// 以下 4 张表为后续「套餐与额度」预留结构
export const plans = pgTable('plans', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceCents: integer('price_cents').notNull().default(0),
  durationDays: integer('duration_days'),
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
    .notNull()
    .default(0),
  monthlyCredits: integer('monthly_credits').notNull().default(0),
  features: jsonb('features')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userSubscriptions = pgTable('user_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id),
  status: text('status').notNull().default('active'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const creditWallets = pgTable('credit_wallets', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  balance: doublePrecision('balance').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: doublePrecision('delta').notNull(),
    balanceAfter: doublePrecision('balance_after').notNull(),
    reason: text('reason').notNull(),
    refId: text('ref_id'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('credit_ledger_user_created_idx').on(table.userId, table.createdAt),
    index('credit_ledger_created_idx').on(table.createdAt),
  ],
);

export const aiBillingTasks = pgTable(
  'ai_billing_tasks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    model: text('model').notNull(),
    taskId: text('task_id').notNull().unique(),
    chargedCredits: doublePrecision('charged_credits').notNull().default(0),
    status: text('status')
      .$type<'pending' | 'completed' | 'refunded'>()
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ai_billing_tasks_user_created_idx').on(table.userId, table.createdAt),
  ],
);

export type RedeemCodeKind = 'credits' | 'storage';
export type StorageGrantSource = 'redeem_code' | 'admin_grant' | 'plan_grant';
export type StorageGrantStatus = 'active' | 'revoked';

export const userStorageGrants = pgTable(
  'user_storage_grants',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(0),
    durationDays: integer('duration_days'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    source: text('source')
      .$type<StorageGrantSource>()
      .notNull()
      .default('redeem_code'),
    refId: text('ref_id'),
    codeId: text('code_id').references(() => redeemCodes.id, {
      onDelete: 'set null',
    }),
    note: text('note').notNull().default(''),
    status: text('status')
      .$type<StorageGrantStatus>()
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('user_storage_grants_user_idx').on(table.userId, table.createdAt),
  ],
);

export const redeemCodes = pgTable('redeem_codes', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull().default(''),
  kind: text('kind').$type<RedeemCodeKind>().notNull().default('credits'),
  credits: doublePrecision('credits').notNull().default(0),
  storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
    .notNull()
    .default(0),
  storageDurationDays: integer('storage_duration_days'),
  maxUses: integer('max_uses').notNull().default(1),
  usedCount: integer('used_count').notNull().default(0),
  note: text('note').notNull().default(''),
  status: text('status')
    .$type<'active' | 'disabled'>()
    .notNull()
    .default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const redeemRecords = pgTable(
  'redeem_records',
  {
    id: text('id').primaryKey(),
    codeId: text('code_id')
      .notNull()
      .references(() => redeemCodes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RedeemCodeKind>().notNull().default('credits'),
    credits: doublePrecision('credits').notNull().default(0),
    storageQuotaBytes: bigint('storage_quota_bytes', { mode: 'number' })
      .notNull()
      .default(0),
    storageDurationDays: integer('storage_duration_days'),
    storageExpiresAtAfter: timestamp('storage_expires_at_after', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('redeem_records_code_user_idx').on(table.codeId, table.userId),
  ],
);

export const announcements = pgTable('announcements', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  level: text('level')
    .$type<'default' | 'ongoing' | 'success' | 'warning' | 'error'>()
    .notNull()
    .default('default'),
  isPinned: boolean('is_pinned').notNull().default(false),
  isPublished: boolean('is_published').notNull().default(true),
  createdBy: text('created_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EmailCodePurpose =
  | 'register'
  | 'bind_email'
  | 'reset_password'
  | 'change_password';

export const emailVerificationCodes = pgTable(
  'email_verification_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    purpose: text('purpose').$type<EmailCodePurpose>().notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('email_verification_codes_lookup_idx').on(
      table.email,
      table.purpose,
      table.createdAt,
    ),
  ],
);
