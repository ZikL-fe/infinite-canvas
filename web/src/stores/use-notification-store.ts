import { create } from "zustand";

import { runtimeApi, type AnnouncementItem, type PlatformGlobalNotice } from "@/services/api/server";

const STORAGE_KEY = "ic_notifications_read_v1";

type PersistedReadState = {
    noticeUpdatedAt: string | null;
    timelineKeys: string[];
};

function readPersistedState(): PersistedReadState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { noticeUpdatedAt: null, timelineKeys: [] };
        const parsed = JSON.parse(raw) as Partial<PersistedReadState>;
        return {
            noticeUpdatedAt: typeof parsed.noticeUpdatedAt === "string" ? parsed.noticeUpdatedAt : null,
            timelineKeys: Array.isArray(parsed.timelineKeys) ? parsed.timelineKeys.filter((item): item is string => typeof item === "string") : [],
        };
    } catch {
        return { noticeUpdatedAt: null, timelineKeys: [] };
    }
}

function writePersistedState(state: PersistedReadState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // 忽略隐私模式下 localStorage 不可用异常
    }
}

export function timelineNotificationKey(item: Pick<AnnouncementItem, "id" | "updatedAt">) {
    return `${item.id}:${item.updatedAt}`;
}

export function getNotificationUnreadCounts(state: {
    notice: PlatformGlobalNotice | null;
    timeline: AnnouncementItem[];
    readNoticeUpdatedAt: string | null;
    readTimelineKeys: string[];
}) {
    const noticeActive = Boolean(state.notice?.enabled && state.notice.content.trim() && state.notice.updatedAt);
    const hasUnreadNotice = Boolean(noticeActive && state.notice?.updatedAt !== state.readNoticeUpdatedAt);
    const readSet = new Set(state.readTimelineKeys);
    const unreadTimelineCount = state.timeline.reduce((acc, item) => (readSet.has(timelineNotificationKey(item)) ? acc : acc + 1), 0);
    return {
        hasUnreadNotice,
        unreadTimelineCount,
        totalUnread: (hasUnreadNotice ? 1 : 0) + unreadTimelineCount,
    };
}

export type NotificationTabKey = "notice" | "timeline";

type NotificationState = {
    notice: PlatformGlobalNotice | null;
    timeline: AnnouncementItem[];
    loaded: boolean;
    loading: boolean;
    modalOpen: boolean;
    activeTab: NotificationTabKey;
    readNoticeUpdatedAt: string | null;
    readTimelineKeys: string[];
    autoPromptedSignature: string | null;
    fetchNotifications: (force?: boolean) => Promise<void>;
    openModal: (tab?: NotificationTabKey) => void;
    closeModalAndMarkRead: () => void;
    markAllRead: () => void;
    setActiveTab: (tab: NotificationTabKey) => void;
};

let inFlightFetch: Promise<void> | null = null;
const initialPersisted = typeof window !== "undefined" ? readPersistedState() : { noticeUpdatedAt: null, timelineKeys: [] };

function buildUnreadSignature(notice: PlatformGlobalNotice | null, timeline: AnnouncementItem[], readNoticeUpdatedAt: string | null, readTimelineKeys: string[]) {
    const readSet = new Set(readTimelineKeys);
    const noticePart = notice?.enabled && notice.content.trim() && notice.updatedAt && notice.updatedAt !== readNoticeUpdatedAt ? notice.updatedAt : "";
    const timelinePart = timeline
        .map((item) => timelineNotificationKey(item))
        .filter((key) => !readSet.has(key))
        .join(",");
    return noticePart || timelinePart ? `${noticePart}|${timelinePart}` : "";
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
    notice: null,
    timeline: [],
    loaded: false,
    loading: false,
    modalOpen: false,
    activeTab: "notice",
    readNoticeUpdatedAt: initialPersisted.noticeUpdatedAt,
    readTimelineKeys: initialPersisted.timelineKeys,
    autoPromptedSignature: null,

    async fetchNotifications(force = false) {
        if (inFlightFetch && !force) return inFlightFetch;
        if (get().loaded && !force) return;

        const run = async () => {
            set({ loading: true });
            try {
                const res = await runtimeApi.getNotifications();
                const current = get();
                const unreadSig = buildUnreadSignature(res.notice, res.timeline, current.readNoticeUpdatedAt, current.readTimelineKeys);
                const { hasUnreadNotice } = getNotificationUnreadCounts({
                    notice: res.notice,
                    timeline: res.timeline,
                    readNoticeUpdatedAt: current.readNoticeUpdatedAt,
                    readTimelineKeys: current.readTimelineKeys,
                });
                const shouldAutoOpen = Boolean(unreadSig && unreadSig !== current.autoPromptedSignature);
                const nextTab: NotificationTabKey = hasUnreadNotice
                    ? "notice"
                    : unreadSig
                      ? "timeline"
                      : res.notice.enabled && res.notice.content.trim()
                        ? "notice"
                        : "timeline";

                set({
                    notice: res.notice,
                    timeline: res.timeline,
                    loaded: true,
                    ...(shouldAutoOpen
                        ? {
                              modalOpen: true,
                              activeTab: nextTab,
                              autoPromptedSignature: unreadSig,
                          }
                        : {}),
                });
            } catch {
                set({ loaded: true });
            } finally {
                set({ loading: false });
            }
        };

        const promise = run().finally(() => {
            if (inFlightFetch === promise) inFlightFetch = null;
        });
        inFlightFetch = promise;
        return promise;
    },

    openModal(tab) {
        const state = get();
        const { hasUnreadNotice, unreadTimelineCount } = getNotificationUnreadCounts(state);
        const resolvedTab: NotificationTabKey =
            tab ??
            (hasUnreadNotice
                ? "notice"
                : unreadTimelineCount > 0
                  ? "timeline"
                  : state.notice?.enabled && state.notice.content.trim()
                    ? "notice"
                    : "timeline");
        set({ modalOpen: true, activeTab: resolvedTab });
        if (!state.loaded) {
            void state.fetchNotifications(true);
        }
    },

    markAllRead() {
        const state = get();
        const nextNoticeAt = state.notice?.enabled && state.notice.updatedAt ? state.notice.updatedAt : state.readNoticeUpdatedAt;
        const currentTimelineKeys = state.timeline.map((item) => timelineNotificationKey(item));
        const nextReadTimeline = Array.from(new Set([...currentTimelineKeys]));
        writePersistedState({
            noticeUpdatedAt: nextNoticeAt,
            timelineKeys: nextReadTimeline,
        });
        set({
            readNoticeUpdatedAt: nextNoticeAt,
            readTimelineKeys: nextReadTimeline,
        });
    },

    closeModalAndMarkRead() {
        get().markAllRead();
        set({ modalOpen: false });
    },

    setActiveTab(tab) {
        set({ activeTab: tab });
    },
}));
