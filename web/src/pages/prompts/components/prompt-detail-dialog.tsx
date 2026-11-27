import { Check, Copy, FileText, FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, type Prompt } from "@/services/api/prompts";

export function PromptDetailDialog({ prompt, onClose, onCopy, onSaveAsset }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void }) {
    const { i18n, t } = useTranslation();
    const contentRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const [savedKey, setSavedKey] = useState<string | null>(null);
    const [failedUrls, setFailedUrls] = useState<Record<string, true>>({});
    const open = Boolean(prompt);
    const promptKey = prompt ? `${prompt.sourceId}:${prompt.id}` : null;
    const isSaved = Boolean(promptKey && savedKey === promptKey);
    const showCover = Boolean(prompt?.coverUrl) && !failedUrls[prompt!.coverUrl];
    const markFailed = (url: string) => setFailedUrls((prev) => (prev[url] ? prev : { ...prev, [url]: true }));

    useEffect(() => {
        if (!open) return;
        const raf = requestAnimationFrame(() => {
            const modal = contentRef.current?.closest<HTMLElement>(".ant-modal");
            (modal || contentRef.current)?.focus({ preventScroll: true });
        });
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
            const wraps = Array.from(document.querySelectorAll<HTMLElement>(".ant-modal-wrap")).filter((el) => el.style.display !== "none");
            const ownWrap = contentRef.current?.closest<HTMLElement>(".ant-modal-wrap");
            if (wraps.length && ownWrap && wraps[wraps.length - 1] !== ownWrap) return;
            event.preventDefault();
            onCloseRef.current();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    return (
        <Modal title={prompt?.title} open={open} onCancel={onClose} footer={null} width={720} centered keyboard destroyOnHidden styles={{ body: { height: "calc(85vh - 55px)", overflow: "hidden" } }}>
            {prompt ? (
                <div ref={contentRef} className="flex h-full min-h-0 flex-col">
                    <div className="shrink-0 space-y-3 pb-4">
                        {showCover ? (
                            <div className="h-48 w-full overflow-hidden rounded-lg sm:h-56">
                                <img src={prompt.coverUrl} alt={prompt.title} referrerPolicy="no-referrer" onError={() => markFailed(prompt.coverUrl)} className="h-full w-full object-cover" />
                            </div>
                        ) : (
                            <div className="grid h-48 w-full place-items-center rounded-lg bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600 sm:h-56">
                                <FileText className="size-9" />
                            </div>
                        )}
                        {prompt.referenceImageUrls.length > 1 ? (
                            <div className="grid grid-cols-6 gap-2">
                                {prompt.referenceImageUrls
                                    .filter((url) => url !== prompt.coverUrl)
                                    .slice(0, 6)
                                    .map((url) =>
                                        failedUrls[url] ? (
                                            <div key={url} className="grid aspect-square w-full place-items-center rounded-md bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600">
                                                <FileText className="size-4" />
                                            </div>
                                        ) : (
                                            <img key={url} src={url} alt="" referrerPolicy="no-referrer" onError={() => markFailed(url)} className="aspect-square w-full rounded-md object-cover" loading="lazy" />
                                        ),
                                    )}
                            </div>
                        ) : null}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto border-y border-stone-200 py-4 pr-2 dark:border-stone-800">
                        <div className="flex flex-wrap gap-1.5">
                            {prompt.tags.map((tag) => (
                                <Tag key={tag} className="m-0 max-w-full truncate">
                                    {tag}
                                </Tag>
                            ))}
                        </div>
                        {prompt.description ? <p className="mt-4 text-sm leading-6 text-stone-500 dark:text-stone-400">{prompt.description}</p> : null}
                        {prompt.preview ? <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-stone-100 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{prompt.preview}</pre> : null}
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-stone-800 dark:text-stone-300">{prompt.prompt}</p>
                        {prompt.createdAt || prompt.updatedAt ? <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">{prompt.createdAt ? t("common.created", { date: formatPromptDate(prompt.createdAt, i18n.resolvedLanguage) }) : null}{prompt.createdAt && prompt.updatedAt ? " · " : null}{prompt.updatedAt ? t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) }) : null}</div> : null}
                    </div>
                    <div className="shrink-0 pt-4">
                        <Space wrap>
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>
                                {t("common.copyPrompt")}
                            </Button>
                            {onSaveAsset ? (
                                <Button
                                    icon={isSaved ? <Check className="size-4" /> : <FolderPlus className="size-4" />}
                                    onClick={() => {
                                        onSaveAsset(prompt);
                                        if (promptKey) setSavedKey(promptKey);
                                    }}
                                >
                                    {t(isSaved ? "common.addedToAssets" : "common.addToAssets")}
                                </Button>
                            ) : null}
                        </Space>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
