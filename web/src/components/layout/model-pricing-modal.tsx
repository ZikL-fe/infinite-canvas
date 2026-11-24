/** 模型积分计费设置弹窗与摘要格式化：支持对话按 M、生图按张/分辨率、视频按秒/次与参考视频加价、语音按秒。 */
import { Alert, Form, InputNumber, Modal, Radio, Switch } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import type {
    AudioModelPricing,
    ImageModelPricing,
    ModelCapability,
    ModelPricing,
    TextModelPricing,
    VideoModelPricing,
} from "@/stores/use-config-store";

export function formatModelPricingSummary(capability: ModelCapability, pricing?: ModelPricing): string {
    if (!pricing) return i18n.t("pricing.free");
    if (capability === "text" && pricing.mode === "token") {
        if (!pricing.inputPerMillion && !pricing.cachedInputPerMillion && !pricing.outputPerMillion) return i18n.t("pricing.free");
        return i18n.t("pricing.tokenSummary", {
            input: pricing.inputPerMillion,
            cached: pricing.cachedInputPerMillion,
            output: pricing.outputPerMillion,
        });
    }
    if (capability === "image") {
        if (pricing.mode === "per_image") {
            return pricing.perImage ? i18n.t("pricing.perImage", { price: pricing.perImage }) : i18n.t("pricing.free");
        }
        if (pricing.mode === "per_resolution" && pricing.resolutionPrices) {
            const p = pricing.resolutionPrices;
            const parts = [
                p["1k"] !== undefined ? `1K:${p["1k"]}` : "",
                p["2k"] !== undefined ? `2K:${p["2k"]}` : "",
                p["4k"] !== undefined ? `4K:${p["4k"]}` : "",
                i18n.t("pricing.defaultLabel", { price: p.default ?? 0 }),
            ].filter(Boolean);
            return parts.join(" · ") + i18n.t("pricing.perImageUnit");
        }
    }
    if (capability === "video") {
        const vp = pricing as VideoModelPricing;
        const base =
            vp.mode === "per_second"
                ? vp.perSecond
                    ? i18n.t("pricing.perSecond", { price: vp.perSecond })
                    : i18n.t("pricing.free")
                : vp.perRequest
                  ? i18n.t("pricing.perRequest", { price: vp.perRequest })
                  : i18n.t("pricing.free");
        if (vp.chargeReferenceVideo && vp.referenceVideoPrice) {
            const extra = vp.referenceVideoMode === "per_second"
                ? i18n.t("pricing.refPerSecond", { price: vp.referenceVideoPrice })
                : i18n.t("pricing.refPerRequest", { price: vp.referenceVideoPrice });
            return i18n.t("pricing.withRef", { base, extra });
        }
        return base;
    }
    if (capability === "audio" && pricing.mode === "per_second") {
        return pricing.perSecond ? i18n.t("pricing.perSecond", { price: pricing.perSecond }) : i18n.t("pricing.free");
    }
    return i18n.t("pricing.free");
}

function defaultPricingFor(capability: ModelCapability): ModelPricing {
    if (capability === "text") return { mode: "token", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 };
    if (capability === "image") return { mode: "per_image", perImage: 0, resolutionPrices: { "1k": 0, "2k": 0, "4k": 0, default: 0 } } as ImageModelPricing;
    if (capability === "video") return { mode: "per_second", perSecond: 0, perRequest: 0, chargeReferenceVideo: false, referenceVideoMode: "per_request", referenceVideoPrice: 0 };
    return { mode: "per_second", perSecond: 0 };
}

export function ModelPricingModal({
    open,
    modelName,
    capability,
    value,
    onSave,
    onClose,
}: {
    open: boolean;
    modelName: string;
    capability: ModelCapability;
    value?: ModelPricing;
    onSave: (pricing?: ModelPricing) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [textPricing, setTextPricing] = useState<TextModelPricing>({ mode: "token", inputPerMillion: 0, cachedInputPerMillion: 0, outputPerMillion: 0 });
    const [imageMode, setImageMode] = useState<"per_image" | "per_resolution">("per_image");
    const [perImage, setPerImage] = useState(0);
    const [res1k, setRes1k] = useState<number | undefined>(undefined);
    const [res2k, setRes2k] = useState<number | undefined>(undefined);
    const [res4k, setRes4k] = useState<number | undefined>(undefined);
    const [resDefault, setResDefault] = useState(0);

    const [videoMode, setVideoMode] = useState<"per_second" | "per_request">("per_second");
    const [videoPerSecond, setVideoPerSecond] = useState(0);
    const [videoPerRequest, setVideoPerRequest] = useState(0);
    const [chargeRefVideo, setChargeRefVideo] = useState(false);
    const [refVideoMode, setRefVideoMode] = useState<"per_second" | "per_request">("per_request");
    const [refVideoPrice, setRefVideoPrice] = useState(0);

    const [audioPerSecond, setAudioPerSecond] = useState(0);

    useEffect(() => {
        if (!open) return;
        const init = value || defaultPricingFor(capability);
        if (capability === "text" && init.mode === "token") {
            setTextPricing({
                mode: "token",
                inputPerMillion: init.inputPerMillion || 0,
                cachedInputPerMillion: init.cachedInputPerMillion || 0,
                outputPerMillion: init.outputPerMillion || 0,
            });
        } else if (capability === "image") {
            const img = init as ImageModelPricing;
            setImageMode(img.mode === "per_resolution" ? "per_resolution" : "per_image");
            setPerImage(img.perImage ?? 0);
            setRes1k(img.resolutionPrices?.["1k"]);
            setRes2k(img.resolutionPrices?.["2k"]);
            setRes4k(img.resolutionPrices?.["4k"]);
            setResDefault(img.resolutionPrices?.default ?? 0);
        } else if (capability === "video") {
            const vid = init as VideoModelPricing;
            setVideoMode(vid.mode === "per_request" ? "per_request" : "per_second");
            setVideoPerSecond(vid.perSecond ?? 0);
            setVideoPerRequest(vid.perRequest ?? 0);
            setChargeRefVideo(Boolean(vid.chargeReferenceVideo));
            setRefVideoMode(vid.referenceVideoMode === "per_second" ? "per_second" : "per_request");
            setRefVideoPrice(vid.referenceVideoPrice ?? 0);
        } else if (capability === "audio") {
            const aud = init as AudioModelPricing;
            setAudioPerSecond(aud.perSecond ?? 0);
        }
    }, [capability, open, value]);

    const handleOk = () => {
        if (capability === "text") {
            onSave(textPricing);
        } else if (capability === "image") {
            onSave(
                imageMode === "per_image"
                    ? { mode: "per_image", perImage }
                    : {
                          mode: "per_resolution",
                          resolutionPrices: {
                              ...(res1k !== undefined ? { "1k": res1k } : {}),
                              ...(res2k !== undefined ? { "2k": res2k } : {}),
                              ...(res4k !== undefined ? { "4k": res4k } : {}),
                              default: resDefault,
                          },
                      },
            );
        } else if (capability === "video") {
            onSave({
                mode: videoMode,
                perSecond: videoPerSecond,
                perRequest: videoPerRequest,
                chargeReferenceVideo: chargeRefVideo,
                referenceVideoMode: refVideoMode,
                referenceVideoPrice: refVideoPrice,
            });
        } else {
            onSave({ mode: "per_second", perSecond: audioPerSecond });
        }
        onClose();
    };

    return (
        <Modal open={open} title={t("pricing.modalTitle", { model: modelName })} onOk={handleOk} onCancel={onClose} okText={t("pricing.savePricing")} cancelText={t("common.cancel")} destroyOnHidden>
            <Alert type="info" showIcon className="mb-4" message={t("pricing.freeHint")} />
            <Form layout="vertical">
                {capability === "text" ? (
                    <>
                        <Form.Item label={t("pricing.inputPerMillion")}>
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.inputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, inputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                        <Form.Item label={t("pricing.cachedInputPerMillion")}>
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.cachedInputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, cachedInputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                        <Form.Item label={t("pricing.outputPerMillion")}>
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.outputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, outputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                    </>
                ) : null}

                {capability === "image" ? (
                    <>
                        <Form.Item label={t("pricing.imageMode")}>
                            <Radio.Group value={imageMode} onChange={(e) => setImageMode(e.target.value)}>
                                <Radio.Button value="per_image">{t("pricing.perImageMode")}</Radio.Button>
                                <Radio.Button value="per_resolution">{t("pricing.perResolutionMode")}</Radio.Button>
                            </Radio.Group>
                        </Form.Item>
                        {imageMode === "per_image" ? (
                            <Form.Item label={t("pricing.creditsPerImage")}>
                                <InputNumber className="w-full" min={0} step={0.5} value={perImage} onChange={(v) => setPerImage(Number(v || 0))} />
                            </Form.Item>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item label={t("pricing.credits1k")}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={res1k} onChange={(v) => setRes1k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label={t("pricing.credits2k")}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={res2k} onChange={(v) => setRes2k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label={t("pricing.credits4k")}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={res4k} onChange={(v) => setRes4k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label={t("pricing.creditsDefault")}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={resDefault} onChange={(v) => setResDefault(Number(v || 0))} />
                                </Form.Item>
                            </div>
                        )}
                    </>
                ) : null}

                {capability === "video" ? (
                    <>
                        <Form.Item label={t("pricing.videoMode")}>
                            <Radio.Group value={videoMode} onChange={(e) => setVideoMode(e.target.value)}>
                                <Radio.Button value="per_second">{t("pricing.perSecondMode")}</Radio.Button>
                                <Radio.Button value="per_request">{t("pricing.perRequestMode")}</Radio.Button>
                            </Radio.Group>
                        </Form.Item>
                        {videoMode === "per_second" ? (
                            <Form.Item label={t("pricing.creditsPerSecond")}>
                                <InputNumber className="w-full" min={0} step={0.5} value={videoPerSecond} onChange={(v) => setVideoPerSecond(Number(v || 0))} />
                            </Form.Item>
                        ) : (
                            <Form.Item label={t("pricing.creditsPerRequest")}>
                                <InputNumber className="w-full" min={0} step={1} value={videoPerRequest} onChange={(v) => setVideoPerRequest(Number(v || 0))} />
                            </Form.Item>
                        )}
                        <Form.Item label={t("pricing.chargeRefVideo")}>
                            <Switch checked={chargeRefVideo} onChange={setChargeRefVideo} />
                        </Form.Item>
                        {chargeRefVideo ? (
                            <>
                                <Form.Item label={t("pricing.refVideoMode")}>
                                    <Radio.Group value={refVideoMode} onChange={(e) => setRefVideoMode(e.target.value)}>
                                        <Radio.Button value="per_request">{t("pricing.refPerRequestMode")}</Radio.Button>
                                        <Radio.Button value="per_second">{t("pricing.refPerSecondMode")}</Radio.Button>
                                    </Radio.Group>
                                </Form.Item>
                                <Form.Item label={t(refVideoMode === "per_second" ? "pricing.refPerSecondLabel" : "pricing.refPerRequestLabel")}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={refVideoPrice} onChange={(v) => setRefVideoPrice(Number(v || 0))} />
                                </Form.Item>
                            </>
                        ) : null}
                    </>
                ) : null}

                {capability === "audio" ? (
                    <Form.Item label={t("pricing.audioCreditsPerSecond")}>
                        <InputNumber className="w-full" min={0} step={0.1} value={audioPerSecond} onChange={(v) => setAudioPerSecond(Number(v || 0))} />
                    </Form.Item>
                ) : null}
            </Form>
        </Modal>
    );
}
