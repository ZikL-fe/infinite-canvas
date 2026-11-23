/** 模型积分计费设置弹窗与摘要格式化：支持对话按 M、生图按张/分辨率、视频按秒/次与参考视频加价、语音按秒。 */
import { Alert, Form, InputNumber, Modal, Radio, Switch } from "antd";
import { useEffect, useState } from "react";

import type {
    AudioModelPricing,
    ImageModelPricing,
    ModelCapability,
    ModelPricing,
    TextModelPricing,
    VideoModelPricing,
} from "@/stores/use-config-store";

export function formatModelPricingSummary(capability: ModelCapability, pricing?: ModelPricing): string {
    if (!pricing) return "免费";
    if (capability === "text" && pricing.mode === "token") {
        if (!pricing.inputPerMillion && !pricing.cachedInputPerMillion && !pricing.outputPerMillion) return "免费";
        return `入${pricing.inputPerMillion} / 缓${pricing.cachedInputPerMillion} / 出${pricing.outputPerMillion} 积分/M`;
    }
    if (capability === "image") {
        if (pricing.mode === "per_image") {
            return pricing.perImage ? `${pricing.perImage} 积分/张` : "免费";
        }
        if (pricing.mode === "per_resolution" && pricing.resolutionPrices) {
            const p = pricing.resolutionPrices;
            const parts = [
                p["1k"] !== undefined ? `1K:${p["1k"]}` : "",
                p["2k"] !== undefined ? `2K:${p["2k"]}` : "",
                p["4k"] !== undefined ? `4K:${p["4k"]}` : "",
                `默认:${p.default ?? 0}`,
            ].filter(Boolean);
            return parts.join(" · ") + " 积分/张";
        }
    }
    if (capability === "video") {
        const vp = pricing as VideoModelPricing;
        const base =
            vp.mode === "per_second"
                ? vp.perSecond
                    ? `${vp.perSecond} 积分/秒`
                    : "免费"
                : vp.perRequest
                  ? `${vp.perRequest} 积分/次`
                  : "免费";
        if (vp.chargeReferenceVideo && vp.referenceVideoPrice) {
            const extra = vp.referenceVideoMode === "per_second" ? `参考+${vp.referenceVideoPrice}/秒` : `参考+${vp.referenceVideoPrice}/次`;
            return `${base}（${extra}）`;
        }
        return base;
    }
    if (capability === "audio" && pricing.mode === "per_second") {
        return pricing.perSecond ? `${pricing.perSecond} 积分/秒` : "免费";
    }
    return "免费";
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
        <Modal open={open} title={`积分计费设置 · ${modelName}`} onOk={handleOk} onCancel={onClose} okText="保存计费" cancelText="取消" destroyOnHidden>
            <Alert type="info" showIcon className="mb-4" message="设为 0 表示免费调用；支持小数（最高 4 位小数精度）" />
            <Form layout="vertical">
                {capability === "text" ? (
                    <>
                        <Form.Item label="输入积分 / 1M Tokens">
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.inputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, inputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                        <Form.Item label="缓存命中输入积分 / 1M Tokens">
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.cachedInputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, cachedInputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                        <Form.Item label="输出积分 / 1M Tokens">
                            <InputNumber className="w-full" min={0} step={0.1} value={textPricing.outputPerMillion} onChange={(v) => setTextPricing((p) => ({ ...p, outputPerMillion: Number(v || 0) }))} />
                        </Form.Item>
                    </>
                ) : null}

                {capability === "image" ? (
                    <>
                        <Form.Item label="图片计费方式">
                            <Radio.Group value={imageMode} onChange={(e) => setImageMode(e.target.value)}>
                                <Radio.Button value="per_image">按张数计费</Radio.Button>
                                <Radio.Button value="per_resolution">按分辨率计费</Radio.Button>
                            </Radio.Group>
                        </Form.Item>
                        {imageMode === "per_image" ? (
                            <Form.Item label="每张图片消耗积分">
                                <InputNumber className="w-full" min={0} step={0.5} value={perImage} onChange={(v) => setPerImage(Number(v || 0))} />
                            </Form.Item>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                <Form.Item label="1K 每张积分（留空走默认）">
                                    <InputNumber className="w-full" min={0} step={0.5} value={res1k} onChange={(v) => setRes1k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label="2K 每张积分（留空走默认）">
                                    <InputNumber className="w-full" min={0} step={0.5} value={res2k} onChange={(v) => setRes2k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label="4K 每张积分（留空走默认）">
                                    <InputNumber className="w-full" min={0} step={0.5} value={res4k} onChange={(v) => setRes4k(v === null ? undefined : Number(v))} />
                                </Form.Item>
                                <Form.Item label="默认 / 自动 每张积分">
                                    <InputNumber className="w-full" min={0} step={0.5} value={resDefault} onChange={(v) => setResDefault(Number(v || 0))} />
                                </Form.Item>
                            </div>
                        )}
                    </>
                ) : null}

                {capability === "video" ? (
                    <>
                        <Form.Item label="视频计费方式">
                            <Radio.Group value={videoMode} onChange={(e) => setVideoMode(e.target.value)}>
                                <Radio.Button value="per_second">按秒计费</Radio.Button>
                                <Radio.Button value="per_request">按请求次数计费</Radio.Button>
                            </Radio.Group>
                        </Form.Item>
                        {videoMode === "per_second" ? (
                            <Form.Item label="每秒消耗积分">
                                <InputNumber className="w-full" min={0} step={0.5} value={videoPerSecond} onChange={(v) => setVideoPerSecond(Number(v || 0))} />
                            </Form.Item>
                        ) : (
                            <Form.Item label="每次请求消耗积分">
                                <InputNumber className="w-full" min={0} step={1} value={videoPerRequest} onChange={(v) => setVideoPerRequest(Number(v || 0))} />
                            </Form.Item>
                        )}
                        <Form.Item label="上传参考视频时是否额外计费">
                            <Switch checked={chargeRefVideo} onChange={setChargeRefVideo} />
                        </Form.Item>
                        {chargeRefVideo ? (
                            <>
                                <Form.Item label="参考视频计费方式">
                                    <Radio.Group value={refVideoMode} onChange={(e) => setRefVideoMode(e.target.value)}>
                                        <Radio.Button value="per_request">每次额外加收</Radio.Button>
                                        <Radio.Button value="per_second">按参考视频秒数加收</Radio.Button>
                                    </Radio.Group>
                                </Form.Item>
                                <Form.Item label={refVideoMode === "per_second" ? "参考视频每秒加收积分" : "每次包含参考视频加收积分"}>
                                    <InputNumber className="w-full" min={0} step={0.5} value={refVideoPrice} onChange={(v) => setRefVideoPrice(Number(v || 0))} />
                                </Form.Item>
                            </>
                        ) : null}
                    </>
                ) : null}

                {capability === "audio" ? (
                    <Form.Item label="每秒音频消耗积分">
                        <InputNumber className="w-full" min={0} step={0.1} value={audioPerSecond} onChange={(v) => setAudioPerSecond(Number(v || 0))} />
                    </Form.Item>
                ) : null}
            </Form>
        </Modal>
    );
}
