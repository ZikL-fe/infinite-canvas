/** 服务端 REST API 请求与响应类型定义。 */
import type { ModelPricing } from "@/stores/use-config-store";
import type { BootstrapStatus, LocalUser, UserRole, UserStatus } from "@/stores/use-user-store";

export type S3Provider = "s3" | "r2" | "oss" | "cos";

export type S3StorageConfigForm = {
    provider: S3Provider;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey?: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
};

export type S3StorageSettingsResponse = {
    configured: boolean;
    config: Omit<S3StorageConfigForm, "secretAccessKey"> & {
        hasSecretKey: boolean;
        secretAccessKeyPreview: string;
    };
};

export type MediaSourceModule = "canvas" | "image_workbench" | "video_workbench" | "assets";

export type WorkspaceDataItem = {
    id: string;
    kind: "canvas" | "image_workbench" | "video_workbench";
    userId: string;
    username: string;
    title: string;
    prompt?: string;
    model?: string;
    status?: string;
    nodeCount?: number;
    mediaCount: number;
    mediaBytes: number;
    dataBytes?: number;
    updatedAt: string;
    createdAt: string;
};

export type MediaItem = {
    id: string;
    userId: string;
    username?: string | null;
    bucket: string;
    objectKey: string;
    kind: "image" | "video" | "audio" | "file";
    mimeType: string;
    bytes: number;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    sourceType: string;
    modules?: MediaSourceModule[];
    meta?: Record<string, unknown>;
    createdAt: string;
    url: string;
    thumbnailUrl?: string;
};

export type AdminMediaByKind = {
    kind: string;
    count: number;
    bytes: number;
};

export type AdminTopStorageUser = {
    id: string;
    username: string;
    displayName: string;
    role: UserRole;
    storageUsedBytes: number;
    storageQuotaBytes?: number;
};

export type DailyTrendItem = {
    date: string;
    credits: number;
    calls: number;
};

export type TopModelUsageItem = {
    model: string;
    credits: number;
    calls: number;
};

export type AnnouncementLevel = "default" | "ongoing" | "success" | "warning" | "error";

export type AnnouncementItem = {
    id: string;
    title: string;
    content: string;
    level: AnnouncementLevel;
    isPinned: boolean;
    isPublished: boolean;
    createdAt: string;
    updatedAt: string;
};

export type PlatformGlobalNotice = {
    enabled: boolean;
    title: string;
    content: string;
    updatedAt: string | null;
};

export type RuntimeNotificationsResponse = {
    notice: PlatformGlobalNotice;
    timeline: AnnouncementItem[];
};

export type AdminOverview = {
    totalUsers: number;
    adminCount: number;
    disabledUsers: number;
    activeMediaCount: number;
    totalStorageBytes: number;
    canvasProjectCount: number;
    assetCount: number;
    mediaByKind: AdminMediaByKind[];
    topStorageUsers: AdminTopStorageUser[];
    storageConfigured: boolean;
    storageBucket: string;
    storageProvider: string;
    days: number;
    totalConsumedCredits: number;
    todayConsumedCredits: number;
    rangeConsumedCredits: number;
    rangeCalls: number;
    dailyTrend: DailyTrendItem[];
    topModels: TopModelUsageItem[];
    announcements: AnnouncementItem[];
};

export type AccountOverviewResponse = {
    creditBalance: number;
    lowBalanceThreshold?: number;
    storageUsedBytes: number;
    storageQuotaBytes: number;
    storageQuotaExpiresAt?: string | null;
    storageWarningDays?: number;
    storageExpiringAt?: string | null;
    storageExpiringBytes?: number;
    storageRemainingAfterExpiryBytes?: number | null;
    storageExpiringWillExceed?: boolean;
    storagePermanentBytes?: number;
    storageTimedBytes?: number;
    storageTimedExpiresAt?: string | null;
    canvasProjectCount: number;
    assetCount: number;
    days: number;
    totalConsumedCredits: number;
    todayConsumedCredits: number;
    rangeConsumedCredits: number;
    rangeCalls: number;
    dailyTrend: DailyTrendItem[];
    topModels: TopModelUsageItem[];
    announcements: AnnouncementItem[];
};

export type UserWebdavView = {
    enabled: boolean;
    url: string;
    username: string;
    directory: string;
    hasPassword: boolean;
    quotaBytes?: number | null;
    usedBytes?: number;
    expiresAt?: string | null;
};

export type StorageGrantItem = {
    id: string;
    quotaBytes: number;
    durationDays: number | null;
    expiresAt: string | null;
    source: "redeem_code" | "admin_grant" | "plan_grant";
    refId: string | null;
    note: string;
    status: "active" | "revoked";
    isExpired: boolean;
    isEffective: boolean;
    createdAt: string;
};

export type StorageQuotaDetail = {
    baseQuotaBytes: number;
    baseExpiresAt: string | null;
    grantsQuotaBytes: number;
    grants: StorageGrantItem[];
};

export type AdminUserInviter = {
    id: string;
    username: string | null;
    displayName: string | null;
};

export type AdminUserItem = LocalUser & {
    isInitialAdmin?: boolean;
    invitedBy?: AdminUserInviter | null;
    baseStorageQuotaBytes?: number;
    baseStorageQuotaExpiresAt?: string | null;
    storageGrantsQuotaBytes?: number;
    activeGrantCount?: number;
    webdavConfig?: UserWebdavView | null;
    mediaCount?: number;
    projectCount?: number;
    creditBalance?: number;
    lastLoginAt?: string | null;
    createdAt: string;
};

export type AdminUserDetailResponse = {
    user: AdminUserItem & {
        emailVerifiedAt?: string | null;
        storagePreExpiryWarnedFor?: string | null;
        storageExpiredWarnedFor?: string | null;
        storageCleanedAt?: string | null;
        lowBalanceAlertEnabled?: boolean | null;
        lowBalanceThreshold?: number | null;
        updatedAt: string;
    };
    stats: {
        totalRechargedCredits: number;
        activeMediaCount: number;
        canvasProjectCount: number;
        assetCount: number;
        imageLogCount: number;
        videoLogCount: number;
        activeSessionCount: number;
    };
    consumption: {
        days: number;
        totalConsumedCredits: number;
        todayConsumedCredits: number;
        rangeConsumedCredits: number;
        rangeCalls: number;
        dailyTrend: DailyTrendItem[];
        topModels: TopModelUsageItem[];
    };
    grants: StorageGrantItem[];
    recentLogs: CreditLedgerItem[];
    sessions: Array<{
        id: string;
        userAgent: string;
        ipAddress: string;
        expiresAt: string;
        revokedAt: string | null;
        createdAt: string;
        active: boolean;
    }>;
};

export type CreditLedgerItem = {
    id: string;
    userId: string;
    username?: string | null;
    displayName?: string | null;
    delta: number;
    balanceAfter: number;
    reason: string;
    refId?: string | null;
    meta?: Record<string, unknown>;
    createdAt: string;
};

export type CreditLedgerSummary = {
    totalConsumed: number;
    totalRecharged: number;
    recordCount: number;
    consumeCalls: number;
    totalTokens: number;
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalImages: number;
    totalMediaSeconds: number;
    avgRpm: number;
    peakRpm: number;
    recentRpm: number;
};

export type RedeemCodeKind = "credits" | "storage";

export type RedeemCodeRedemption = {
    userId: string;
    username: string;
    displayName: string;
    redeemedAt: string;
};

export type RedeemCodeItem = {
    id: string;
    code: string;
    name: string;
    kind: RedeemCodeKind;
    credits: number;
    storageQuotaBytes: number;
    storageDurationDays?: number | null;
    maxUses: number;
    usedCount: number;
    note: string;
    status: "active" | "disabled";
    expiresAt?: string | null;
    createdAt: string;
    redemption?: RedeemCodeRedemption | null;
};

export type AdminChannelModel = {
    name: string;
    capability: "image" | "video" | "text" | "audio";
    script?: string;
    pricing?: ModelPricing;
};

export type AdminChannelItem = {
    id: string;
    name: string;
    alias?: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    enabled: boolean;
    models: AdminChannelModel[];
    hasApiKey?: boolean;
    apiKeyPreview?: string;
    apiKey?: string;
};

export type AdminWebdavSettings = {
    enabled: boolean;
    url: string;
    username: string;
    baseDirectory: string;
    autoAssignNewUsers: boolean;
    hasPassword: boolean;
    passwordPreview: string;
};

export type AdminMailSettings = {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    hasPassword: boolean;
    passwordPreview: string;
    fromName: string;
    fromAddress: string;
    lowBalanceAlertEnabled: boolean;
    lowBalanceThreshold: number;
    lowBalanceCooldownHours: number;
    ready: boolean;
};

export type AdminAuthRateLimitPolicy = {
    enabled: boolean;
    loginPerMinute: number;
    registerPerMinute: number;
    emailCodePerMinute: number;
    redeemPerMinute: number;
};

export type AdminAuthPolicy = {
    allowRegister: boolean;
    requireEmailOnRegister: boolean;
    rateLimit: AdminAuthRateLimitPolicy;
};

export type AdminAuthSettings = AdminAuthPolicy & {
    emailEnabled: boolean;
};

export type AdminMailSettingsForm = {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password?: string;
    fromName: string;
    fromAddress: string;
    lowBalanceAlertEnabled: boolean;
    lowBalanceThreshold: number;
    lowBalanceCooldownHours: number;
};

export type AdminStorageExpiryPolicyForm = {
    enabled: boolean;
    gracePeriodDays: number;
    preExpiryWarnDays: number;
    cleanupWorkspaceData: boolean;
    exemptAdmins: boolean;
    cleanupOverQuotaWithoutExpiry: boolean;
};

export type AdminStorageExpiryPolicy = AdminStorageExpiryPolicyForm & {
    mailReady: boolean;
};

export type StorageExpiryActionKind = "pre_expiry_warn" | "expired_notice" | "cleaned" | "over_quota_cleaned";

export type StorageExpirySweepItem = {
    userId: string;
    username: string;
    displayName: string;
    email: string | null;
    action: StorageExpiryActionKind;
    expiresAt: string | null;
    graceEndsAt: string | null;
    quotaBytes: number;
    usedBytes: number;
    deletedMediaCount: number;
    freedBytes: number;
    deletedCanvasCount: number;
    deletedWorkbenchCount: number;
    deletedAssetCount: number;
    emailSent: boolean;
    error?: string;
};

export type StorageExpirySweepResult = {
    ok: boolean;
    dryRun: boolean;
    skippedDisabled?: boolean;
    executedAt: string;
    policy: AdminStorageExpiryPolicyForm;
    scannedUsers: number;
    eligibleUsers: number;
    preExpiryWarned: number;
    expiredNoticed: number;
    cleanedUsers: number;
    freedBytesTotal: number;
    skippedNoEmail: number;
    failedCount: number;
    truncated: boolean;
    items: StorageExpirySweepItem[];
};

export type RuntimeConfigResponse = {
    channels: Array<{
        id: string;
        name: string;
        apiFormat: "openai" | "gemini";
        baseUrl: string;
        models: AdminChannelModel[];
    }>;
    webdav: {
        enabled: boolean;
        isExpired?: boolean;
        isQuotaExceeded?: boolean;
    } | null;
};

export type AccountLowBalanceAlertConfig = {
    enabled: boolean | null;
    threshold: number | null;
    effectiveEnabled: boolean;
    effectiveThreshold: number;
    platformEnabled: boolean;
    platformThreshold: number;
    cooldownHours: number;
    lastAlertedAt: string | null;
};

export type AccountProfileResponse = {
    user: LocalUser & { lastLoginAt?: string | null; createdAt: string };
    emailServiceEnabled?: boolean;
    requireEmailOnRegister?: boolean;
    lowBalanceAlert?: AccountLowBalanceAlertConfig;
    storageQuotaDetail?: StorageQuotaDetail;
    stats: {
        canvasProjectCount: number;
        assetCount: number;
        mediaByKind: AdminMediaByKind[];
    };
    webdav: {
        enabled: boolean;
        url: string;
        username: string;
        directory: string;
        quotaBytes?: number | null;
        usedBytes?: number;
        expiresAt?: string | null;
        isExpired?: boolean;
        isQuotaExceeded?: boolean;
    } | null;
};

export type AccountSessionItem = {
    id: string;
    userAgent: string;
    ip: string;
    createdAt: string;
    expiresAt: string;
    isCurrent: boolean;
};

export type DashboardRange = "today" | "24h" | "7d" | "30d";

export type PlatformAnalyticsPolicy = {
    sampleIntervalMinutes: number;
    logRetentionDays: number;
};

export type PlatformInvitePolicy = {
    enabled: boolean;
    rebatePercent: number;
    includeAdminAdjust: boolean;
};

export type AccountInviteItem = {
    id: string;
    username: string;
    displayName: string;
    status: UserStatus;
    createdAt: string;
    rechargedCredits: number;
    rebateCredits: number;
    reclaimedCredits: number;
    netRebateCredits: number;
};

export type AccountInvitesResponse = {
    enabled: boolean;
    rebatePercent: number;
    includeAdminAdjust: boolean;
    inviteCode: string;
    invitedCount: number;
    grossRebateCredits: number;
    reclaimedRebateCredits: number;
    netRebateCredits: number;
    page: number;
    pageSize: number;
    items: AccountInviteItem[];
};

export type AnalyticsDashboardResponse = {
    range: DashboardRange;
    sampledAt: string;
    sampleIntervalMinutes: number;
    bucketUnit: "hour" | "day";
    summary: {
        totalCalls: number;
        totalConsumedCredits: number;
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        avgRpm: number;
        avgTpm: number;
        successRate: number;
        avgLatencyMs: number;
        avgTokensPerSecond: number;
    };
    modelHealth: Array<{
        model: string;
        calls: number;
        successRate: number;
    }>;
    buckets: string[];
    models: string[];
    modelCreditSeries: Array<{ model: string; data: number[] }>;
    modelCallSeries: Array<{ model: string; data: number[] }>;
    modelRanking: Array<{ model: string; calls: number; credits: number; successRate: number }>;
    userRanking?: Array<{
        userId: string;
        username: string;
        displayName: string;
        email: string | null;
        credits: number;
        calls: number;
    }>;
    userTrendSeries?: Array<{
        userId: string;
        label: string;
        data: number[];
    }>;
};
