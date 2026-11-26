/** 生图工作台批量模式纯函数工具：三种批量场景的任务推导、槽位对齐校验、并发排队执行与类型定义。 */
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import type { ReferenceImage } from "@/types/image";

export const MAX_BATCH_IMAGES = 100;
export const DEFAULT_BATCH_CONCURRENCY = 3;
export const MAX_BATCH_CONCURRENCY = 10;

export type BatchScenario = "same-prompt" | "multi-prompt" | "custom";
export type PromptSplitMode = "line" | "blank";

/** 多图同词任务槽位：每个槽位对应一组独立生图请求，内部可放入图1/图2/图3等参考图。 */
export type SamePromptTaskSlot = {
    id: string;
    references: ReferenceImage[];
};

export function createSamePromptSlot(references: ReferenceImage[] = []): SamePromptTaskSlot {
    return {
        id: nanoid(),
        references: references.map((ref) => ({ ...ref })),
    };
}

export type BatchSlotReference = ReferenceImage | null;

export type BatchTaskItem = {
    id: string;
    prompt: string;
    references: BatchSlotReference[];
};

export type ResolvedBatchTask = {
    id: string;
    prompt: string;
    references: ReferenceImage[];
};

export type BatchSlotResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: {
        id: string;
        dataUrl: string;
        storageKey?: string;
        durationMs: number;
        width: number;
        height: number;
        bytes: number;
        mimeType?: string;
    };
    error?: string;
};

export type BatchResultGroup = {
    id: string;
    index: number;
    prompt: string;
    references: ReferenceImage[];
    logId?: string;
    status: "queued" | "pending" | "success" | "partial" | "failed" | "cancelled";
    results: BatchSlotResult[];
};

export function createEmptyBatchItem(prompt = "", references: BatchSlotReference[] = []): BatchTaskItem {
    return {
        id: nanoid(),
        prompt,
        references: references.map((ref) => (ref ? { ...ref, id: nanoid() } : null)),
    };
}

export function getDenseReferences(references: BatchSlotReference[]): ReferenceImage[] {
    return references.filter((ref): ref is ReferenceImage => Boolean(ref));
}

export function splitBatchPrompts(raw: string, mode: PromptSplitMode): string[] {
    const normalized = raw.trim();
    if (!normalized) return [];
    const parts = mode === "blank" ? normalized.split(/\r?\n\s*\r?\n+/) : normalized.split(/\r?\n/);
    return parts.map((item) => item.trim()).filter(Boolean);
}

/** 场景 1（多图同词）：每个非空任务槽位生成 1 组独立生图请求，共用同一句提示词。 */
export function buildSamePromptBatchTasks(
    rawPrompt: string,
    slots: SamePromptTaskSlot[],
): {
    tasks: ResolvedBatchTask[];
    missingReason: string | null;
} {
    const prompt = rawPrompt.trim();
    const validSlots = slots.filter((slot) => slot.references.length > 0);

    if (!validSlots.length) {
        return {
            tasks: [],
            missingReason: i18n.t("imageBatch.slot1Required"),
        };
    }

    return {
        tasks: validSlots.map((slot) => ({
            id: slot.id,
            prompt,
            references: [...slot.references],
        })),
        missingReason: !prompt ? i18n.t("imageBatch.sharedPromptRequired") : null,
    };
}

/** 场景 2（一图多词）：每条提示词对应一条任务，自动复用同一组参考图（支持 0 张纯文生图或 1+ 张图）。 */
export function buildMultiPromptBatchTasks(
    rawPrompts: string,
    splitMode: PromptSplitMode,
    sharedRefs: ReferenceImage[],
): {
    tasks: ResolvedBatchTask[];
    missingReason: string | null;
} {
    const prompts = splitBatchPrompts(rawPrompts, splitMode);
    if (!prompts.length) {
        return {
            tasks: [],
            missingReason: i18n.t("imageBatch.multiPromptRequired"),
        };
    }
    return {
        tasks: prompts.map((prompt, idx) => ({
            id: `multi-${idx}`,
            prompt,
            references: [...sharedRefs],
        })),
        missingReason: null,
    };
}

/** 以固定并发上限顺序消费异步任务队列，支持随时中止尚未开始的后续任务。 */
export async function runConcurrentQueue<T>(
    tasks: T[],
    concurrency: number,
    worker: (task: T, index: number) => Promise<void>,
    shouldStop: () => boolean,
    onSkipped?: (task: T, index: number) => void,
) {
    const limit = Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Math.floor(concurrency || DEFAULT_BATCH_CONCURRENCY)));
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const index = cursor;
            cursor += 1;
            const task = tasks[index];
            if (shouldStop()) {
                onSkipped?.(task, index);
                continue;
            }
            await worker(task, index);
        }
    });

    await Promise.all(runners);
}
