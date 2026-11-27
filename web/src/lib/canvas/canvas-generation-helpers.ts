import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { storageApi } from "@/services/api/server";
import { isCloudAuthenticated } from "@/services/cloud-media";
import { ensureImagePreview, getImageBlob, prefetchUncachedImageUrls, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { prefetchUncachedMediaUrls, resolveMediaUrl } from "@/services/file-storage";
import { imageMetadata, referenceUrl } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function imageExtension(dataUrl: string, mimeType?: string) {
    if (mimeType?.includes("gif")) return "gif";
    if (mimeType?.includes("webp")) return "webp";
    if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
    const fromData = dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1];
    if (fromData) return fromData === "jpeg" ? "jpg" : fromData;
    const fromUrl = dataUrl.split("?")[0]?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
    if (fromUrl && ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(fromUrl)) {
        return fromUrl === "jpeg" ? "jpg" : fromUrl;
    }
    return "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    const imageKeys: string[] = [];
    const mediaKeys: string[] = [];
    for (const node of nodes) {
        const metadata = node.metadata;
        if (!metadata) continue;
        if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && metadata.storageKey) {
            mediaKeys.push(metadata.storageKey);
        } else if (node.type === CanvasNodeType.Image) {
            if (metadata.storageKey) imageKeys.push(metadata.storageKey);
            metadata.images?.forEach((img) => {
                if (img.storageKey) imageKeys.push(img.storageKey);
            });
        }
    }
    await Promise.all([prefetchUncachedImageUrls(imageKeys), prefetchUncachedMediaUrls(mediaKeys)]);

    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content || "";
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && metadata?.storageKey) {
                return { ...node, metadata: { ...metadata, content: await resolveMediaUrl(metadata.storageKey, content) } };
            }
            if (node.type !== CanvasNodeType.Image || !metadata) return node;

            const images = metadata.images?.length
                ? await Promise.all(
                      metadata.images.map(async (image) => {
                          if (image.storageKey) {
                              return { ...image, content: await resolveImageUrl(image.storageKey, image.content || "") };
                          }
                          if (!image.content) return image;
                          return image;
                      }),
                  )
                : undefined;

            const primarySlot = images?.find((img) => img.id === metadata.primaryImageId) || images?.find((img) => img.content);
            if (metadata.storageKey) {
                const resolved = await resolveImageUrl(metadata.storageKey, content);
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        content: resolved || primarySlot?.content || content,
                        ...(images ? { images } : {}),
                    },
                };
            }
            if (images) {
                return {
                    ...node,
                    metadata: {
                        ...metadata,
                        content: content || primarySlot?.content || "",
                        ...(primarySlot?.storageKey && !metadata.storageKey ? { storageKey: primarySlot.storageKey } : {}),
                        images,
                    },
                };
            }
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...metadata, ...imageMetadata(await uploadImage(content, { localOnly: true })) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const refKeys: string[] = [];
    sessions.forEach((session) =>
        session.messages.forEach((message) =>
            message.references?.forEach((ref) => {
                if (ref.storageKey) refKeys.push(ref.storageKey);
            }),
        ),
    );
    await prefetchUncachedImageUrls(refKeys);

    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl, { localOnly: true });
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    const resources = [...new Map(inputs.flatMap((input) => (input.type === "group" ? input.children : [input])).map((input) => [input.nodeId, input])).values()];
    return {
        textCount: resources.filter((input) => input.type === "text").length,
        imageCount: resources.filter((input) => input.type === "image").length,
        videoCount: resources.filter((input) => input.type === "video").length,
        audioCount: resources.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
    };
}

export function hasResumableVideoTask(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId) && !node.metadata?.content;
}

function isRecoverableSlotStatus(status: string | undefined, content: string | undefined) {
    return status === "loading" || (status === "error" && !content);
}

function shouldBackfillGenericError(currentError: string | undefined) {
    if (!currentError) return true;
    const genericMessages = new Set([
        i18n.t("canvas.node.failed"),
        i18n.t("canvas.projectPage.generationFailed"),
        i18n.t("canvas.projectPage.allFailed"),
        i18n.t("canvas.generation.interrupted"),
    ]);
    return genericMessages.has(currentError);
}

function collectNodeTaskIds(node: CanvasNodeData): string[] {
    const ids: string[] = [];
    if (node.type === CanvasNodeType.Image) {
        const slotIds = (node.metadata?.images || [])
            .filter((img) => isRecoverableSlotStatus(img.status, img.content))
            .map((img) => img.id);
        ids.push(...slotIds);
        if (node.metadata?.primaryImageId) ids.push(node.metadata.primaryImageId);
        ids.push(node.id);
    } else if (node.type === CanvasNodeType.Text) {
        const slotIds = (node.metadata?.texts || [])
            .filter((text) => isRecoverableSlotStatus(text.status, text.content))
            .map((text) => text.id);
        ids.push(...slotIds);
        if (node.metadata?.primaryTextId) ids.push(node.metadata.primaryTextId);
        ids.push(node.id);
    } else if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
        ids.push(node.id);
    }
    return ids;
}

function isRecoverableCanvasNode(node: CanvasNodeData, activeNodeIds?: Set<string>) {
    if (activeNodeIds?.has(node.id)) return false;
    const status = node.metadata?.status;
    if (status === "loading") return true;
    if (status !== "error") return false;
    if (node.type === CanvasNodeType.Image) {
        return !node.metadata?.content || Boolean(node.metadata.images?.some((img) => img.status === "error" && !img.content));
    }
    if (node.type === CanvasNodeType.Text) {
        return !node.metadata?.content || Boolean(node.metadata.texts?.some((text) => text.status === "error" && !text.content));
    }
    if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
        return !node.metadata?.content;
    }
    return false;
}

export function collectInterruptedImageTaskIds(nodes: CanvasNodeData[], activeNodeIds?: Set<string>) {
    const loadingIds: string[] = [];
    const errorIds: string[] = [];
    for (const node of nodes) {
        if (!isRecoverableCanvasNode(node, activeNodeIds)) continue;
        const target = node.metadata?.status === "loading" ? loadingIds : errorIds;
        target.push(...collectNodeTaskIds(node));
    }
    return Array.from(new Set([...loadingIds, ...errorIds]));
}

async function resolveRecoveredCloudImage(
    media: { id: string; url?: string; width?: number | null; height?: number | null; bytes?: number; mimeType?: string },
    fallbackWidth: number,
    fallbackHeight: number,
) {
    const blob = await getImageBlob(media.id).catch(() => null);
    void ensureImagePreview(media.id);
    const content = await resolveImageUrl(media.id, media.url || "");
    return {
        content: content || media.url || "",
        storageKey: media.id,
        naturalWidth: media.width || fallbackWidth,
        naturalHeight: media.height || fallbackHeight,
        bytes: blob?.size || media.bytes || 0,
        mimeType: blob?.type || media.mimeType || "image/png",
    };
}

export async function recoverCloudInterruptedImages(
    nodes: CanvasNodeData[],
    activeNodeIds?: Set<string>,
): Promise<{ nodes: CanvasNodeData[]; processingTaskIds: string[]; requestFailed?: boolean }> {
    if (!isCloudAuthenticated()) return { nodes, processingTaskIds: [] };
    const candidateIds = collectInterruptedImageTaskIds(nodes, activeNodeIds);
    if (!candidateIds.length) return { nodes, processingTaskIds: [] };

    try {
        const res = await storageApi.getByTasks(candidateIds);
        const processingSet = new Set(res.processingTaskIds);
        const textByTask = res.textByTask || {};
        const videoTaskByClientTask = res.videoTaskByClientTask || {};
        const errorByTask = res.errorByTask || {};
        let anyChanged = false;
        const nextNodes = await Promise.all(
            nodes.map(async (node) => {
                if (!isRecoverableCanvasNode(node, activeNodeIds)) return node;
                const wasErrorNode = node.metadata?.status === "error";

                if (node.type === CanvasNodeType.Text) {
                    const texts = node.metadata?.texts;
                    if (texts?.length) {
                        let changed = false;
                        const nextTexts = texts.map((item) => {
                            if (!isRecoverableSlotStatus(item.status, item.content)) return item;
                            const recoveredText = textByTask[item.id];
                            if (recoveredText) {
                                changed = true;
                                return { id: item.id, status: "success" as const, content: recoveredText };
                            }
                            if (processingSet.has(item.id) && item.status !== "loading") {
                                changed = true;
                                return { ...item, status: "loading" as const, errorDetails: undefined };
                            }
                            const failedMsg = errorByTask[item.id];
                            if (failedMsg && (item.status === "loading" || shouldBackfillGenericError(item.errorDetails)) && item.errorDetails !== failedMsg) {
                                changed = true;
                                return { id: item.id, status: "error" as const, content: "", errorDetails: failedMsg };
                            }
                            return item;
                        });
                        if (!changed) return node;
                        anyChanged = true;
                        const stillLoading = nextTexts.some((item) => item.status === "loading" && processingSet.has(item.id));
                        const hasLoadingSlot = nextTexts.some((item) => item.status === "loading");
                        const successTexts = nextTexts.filter((item) => item.status === "success");
                        const primaryText =
                            (node.metadata?.primaryTextId ? successTexts.find((item) => item.id === node.metadata?.primaryTextId) : undefined) ||
                            successTexts[0];
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                content: primaryText?.content || node.metadata?.content || "",
                                primaryTextId: primaryText?.id || node.metadata?.primaryTextId,
                                texts: nextTexts,
                                status: stillLoading || hasLoadingSlot ? ("loading" as const) : successTexts.length ? ("success" as const) : ("error" as const),
                                errorDetails: successTexts.length || stillLoading || hasLoadingSlot ? undefined : nextTexts.find((item) => item.errorDetails)?.errorDetails,
                            },
                        };
                    }

                    const singleTaskId = node.metadata?.primaryTextId || node.id;
                    const singleText = textByTask[singleTaskId] ?? textByTask[node.id];
                    if (singleText) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                content: singleText,
                                status: "success" as const,
                                errorDetails: undefined,
                            },
                        };
                    }
                    if (wasErrorNode && (processingSet.has(singleTaskId) || processingSet.has(node.id))) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "loading" as const,
                                errorDetails: undefined,
                            },
                        };
                    }
                    const singleErr = errorByTask[singleTaskId] ?? errorByTask[node.id];
                    if (singleErr && (!wasErrorNode || (shouldBackfillGenericError(node.metadata?.errorDetails) && node.metadata?.errorDetails !== singleErr))) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "error" as const,
                                errorDetails: singleErr,
                            },
                        };
                    }
                    return node;
                }

                if (node.type === CanvasNodeType.Video) {
                    const media = res.itemsByTask[node.id]?.[0];
                    if (media) {
                        const url = await resolveMediaUrl(media.id, media.url || "");
                        if (url) {
                            anyChanged = true;
                            const videoSize = fitNodeSize(media.width || node.width, media.height || node.height, 420, 420);
                            return {
                                ...node,
                                width: videoSize.width,
                                height: videoSize.height,
                                metadata: {
                                    ...node.metadata,
                                    content: url,
                                    storageKey: media.id,
                                    naturalWidth: media.width || undefined,
                                    naturalHeight: media.height || undefined,
                                    bytes: media.bytes || 0,
                                    mimeType: media.mimeType || "video/mp4",
                                    durationMs: media.durationMs || undefined,
                                    status: "success" as const,
                                    errorDetails: undefined,
                                },
                            };
                        }
                    }
                    const upstreamVideo = videoTaskByClientTask[node.id];
                    if (upstreamVideo?.taskId && !node.metadata?.videoTaskId) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "loading" as const,
                                errorDetails: undefined,
                                videoTaskId: upstreamVideo.taskId,
                                videoTaskProvider: upstreamVideo.provider === "gemini" ? ("gemini" as const) : ("openai" as const),
                                ...(upstreamVideo.model ? { model: upstreamVideo.model } : {}),
                            },
                        };
                    }
                    if (wasErrorNode && processingSet.has(node.id)) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "loading" as const,
                                errorDetails: undefined,
                            },
                        };
                    }
                    const videoErr = errorByTask[node.id];
                    if (videoErr && (!wasErrorNode || (shouldBackfillGenericError(node.metadata?.errorDetails) && node.metadata?.errorDetails !== videoErr))) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "error" as const,
                                errorDetails: videoErr,
                            },
                        };
                    }
                    return node;
                }

                if (node.type === CanvasNodeType.Audio) {
                    const media = res.itemsByTask[node.id]?.[0];
                    if (media) {
                        const url = await resolveMediaUrl(media.id, media.url || "");
                        if (url) {
                            anyChanged = true;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: url,
                                    storageKey: media.id,
                                    bytes: media.bytes || 0,
                                    mimeType: media.mimeType || "audio/mpeg",
                                    durationMs: media.durationMs || undefined,
                                    status: "success" as const,
                                    errorDetails: undefined,
                                },
                            };
                        }
                    }
                    if (wasErrorNode && processingSet.has(node.id)) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "loading" as const,
                                errorDetails: undefined,
                            },
                        };
                    }
                    const audioErr = errorByTask[node.id];
                    if (audioErr && (!wasErrorNode || (shouldBackfillGenericError(node.metadata?.errorDetails) && node.metadata?.errorDetails !== audioErr))) {
                        anyChanged = true;
                        return {
                            ...node,
                            metadata: {
                                ...node.metadata,
                                status: "error" as const,
                                errorDetails: audioErr,
                            },
                        };
                    }
                    return node;
                }

                if (node.type !== CanvasNodeType.Image) return node;

                const images = node.metadata?.images;
                if (images?.length) {
                    let changed = false;
                    const singleSlot = images.length === 1;
                    const nextImages = await Promise.all(
                        images.map(async (img) => {
                            if (!isRecoverableSlotStatus(img.status, img.content)) return img;
                            const media =
                                res.itemsByTask[img.id]?.[0] ||
                                (singleSlot
                                    ? (node.metadata?.primaryImageId ? res.itemsByTask[node.metadata.primaryImageId]?.[0] : undefined) ||
                                      res.itemsByTask[node.id]?.[0]
                                    : undefined);
                            if (media) {
                                const recovered = await resolveRecoveredCloudImage(media, node.width, node.height);
                                if (recovered.content) {
                                    changed = true;
                                    return {
                                        id: img.id,
                                        status: "success" as const,
                                        ...recovered,
                                    };
                                }
                            }
                            const slotStillProcessing =
                                processingSet.has(img.id) ||
                                (singleSlot &&
                                    (processingSet.has(node.id) || Boolean(node.metadata?.primaryImageId && processingSet.has(node.metadata.primaryImageId))));
                            if (slotStillProcessing) {
                                if (img.status !== "loading") {
                                    changed = true;
                                    return { ...img, status: "loading" as const, errorDetails: undefined };
                                }
                                return img;
                            }
                            const slotErr = errorByTask[img.id] ?? (singleSlot ? errorByTask[node.id] : undefined);
                            if (slotErr && (img.status === "loading" || (shouldBackfillGenericError(img.errorDetails) && img.errorDetails !== slotErr))) {
                                changed = true;
                                return { ...img, status: "error" as const, errorDetails: slotErr };
                            }
                            return img;
                        }),
                    );
                    const stillLoading = nextImages.some(
                        (img) =>
                            img.status === "loading" &&
                            (processingSet.has(img.id) ||
                                (singleSlot &&
                                    (processingSet.has(node.id) || Boolean(node.metadata?.primaryImageId && processingSet.has(node.metadata.primaryImageId))))),
                    );
                    const hasLoadingSlot = nextImages.some((img) => img.status === "loading");
                    if (!changed && (hasLoadingSlot || wasErrorNode)) return node;
                    anyChanged = true;

                    const hasSuccess = nextImages.some((img) => img.status === "success");
                    const matchedPrimary = node.metadata?.primaryImageId
                        ? nextImages.find((img) => img.id === node.metadata?.primaryImageId && img.status === "success" && img.content)
                        : undefined;
                    const primaryBuilt =
                        matchedPrimary ||
                        (!node.metadata?.primaryImageId || !node.metadata?.content
                            ? nextImages.find((img) => img.status === "success" && img.content)
                            : undefined);
                    const primaryPatch = primaryBuilt
                        ? (() => {
                              const imageSize = fitNodeSize(primaryBuilt.naturalWidth || node.width, primaryBuilt.naturalHeight || node.height, node.width, node.height);
                              const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                              return {
                                  position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                  ...imageSize,
                                  metadata: {
                                      ...node.metadata,
                                      content: primaryBuilt.content,
                                      storageKey: primaryBuilt.storageKey,
                                      naturalWidth: primaryBuilt.naturalWidth,
                                      naturalHeight: primaryBuilt.naturalHeight,
                                      bytes: primaryBuilt.bytes,
                                      mimeType: primaryBuilt.mimeType,
                                      primaryImageId: primaryBuilt.id,
                                  },
                              };
                          })()
                        : null;
                    const baseMeta = primaryPatch?.metadata || node.metadata;
                    const firstSlotErr = nextImages.find((img) => img.status === "error" && img.errorDetails)?.errorDetails;
                    return {
                        ...node,
                        ...(primaryPatch ? { position: primaryPatch.position, width: primaryPatch.width, height: primaryPatch.height } : {}),
                        metadata: {
                            ...baseMeta,
                            images: nextImages,
                            status: stillLoading ? ("loading" as const) : hasSuccess ? ("success" as const) : ("error" as const),
                            errorDetails: hasSuccess || stillLoading ? undefined : firstSlotErr || baseMeta?.errorDetails,
                        },
                    };
                }

                const media =
                    (node.metadata?.primaryImageId ? res.itemsByTask[node.metadata.primaryImageId]?.[0] : undefined) ||
                    res.itemsByTask[node.id]?.[0];
                if (media) {
                    const recovered = await resolveRecoveredCloudImage(media, node.width, node.height);
                    if (!recovered.content) return node;
                    anyChanged = true;
                    const imageSize = fitNodeSize(recovered.naturalWidth, recovered.naturalHeight, node.width, node.height);
                    return {
                        ...node,
                        width: imageSize.width,
                        height: imageSize.height,
                        metadata: {
                            ...node.metadata,
                            ...recovered,
                            status: "success" as const,
                            errorDetails: undefined,
                        },
                    };
                }
                const singleImageProcessing =
                    processingSet.has(node.id) || Boolean(node.metadata?.primaryImageId && processingSet.has(node.metadata.primaryImageId));
                if (wasErrorNode && singleImageProcessing) {
                    anyChanged = true;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            status: "loading" as const,
                            errorDetails: undefined,
                        },
                    };
                }
                const singleImageErr =
                    (node.metadata?.primaryImageId ? errorByTask[node.metadata.primaryImageId] : undefined) ?? errorByTask[node.id];
                if (singleImageErr && (!wasErrorNode || (shouldBackfillGenericError(node.metadata?.errorDetails) && node.metadata?.errorDetails !== singleImageErr))) {
                    anyChanged = true;
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            status: "error" as const,
                            errorDetails: singleImageErr,
                        },
                    };
                }
                return node;
            }),
        );
        return { nodes: anyChanged ? nextNodes : nodes, processingTaskIds: res.processingTaskIds, requestFailed: false };
    } catch {
        return { nodes, processingTaskIds: [], requestFailed: true };
    }
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[], activeNodeIds?: Set<string>, processingTaskIds?: string[]) {
    const processingSet = new Set(processingTaskIds || []);
    return nodes.map((node) => {
        if (node.metadata?.status !== "loading") return node;
        if (hasResumableVideoTask(node) || activeNodeIds?.has(node.id)) return node;
        if (node.type === CanvasNodeType.Config) {
            return {
                ...node,
                metadata: {
                    ...node.metadata,
                    status: "idle" as const,
                    errorDetails: undefined,
                },
            };
        }
        const imageStillProcessing =
            node.type === CanvasNodeType.Image &&
            (processingSet.has(node.id) ||
                Boolean(node.metadata.primaryImageId && processingSet.has(node.metadata.primaryImageId)) ||
                Boolean(node.metadata.images?.some((img) => img.status === "loading" && processingSet.has(img.id))));
        const textStillProcessing =
            node.type === CanvasNodeType.Text &&
            (processingSet.has(node.id) ||
                Boolean(node.metadata.primaryTextId && processingSet.has(node.metadata.primaryTextId)) ||
                Boolean(node.metadata.texts?.some((text) => text.status === "loading" && processingSet.has(text.id))));
        const mediaStillProcessing =
            (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) && processingSet.has(node.id);
        if (imageStillProcessing || textStillProcessing || mediaStillProcessing) return node;

        const nextTexts = node.metadata.texts?.map((text) =>
            text.status === "loading" && !processingSet.has(text.id)
                ? { ...text, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") }
                : text,
        );
        const hasSuccessText = Boolean(nextTexts?.some((text) => text.status === "success"));

        return {
            ...node,
            metadata: {
                ...node.metadata,
                status: hasSuccessText ? ("success" as const) : ("error" as const),
                errorDetails: hasSuccessText ? undefined : i18n.t("canvas.generation.interrupted"),
                images: node.metadata.images?.map((image) =>
                    image.status === "loading" && !processingSet.has(image.id)
                        ? { ...image, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") }
                        : image,
                ),
                texts: nextTexts,
            },
        };
    });
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}
