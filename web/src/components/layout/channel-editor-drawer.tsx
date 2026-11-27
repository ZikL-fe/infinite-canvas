import { Button, Drawer, Input, Segmented, Select, Space, Tag } from "antd";
import { Code2, Coins, ListPlus, Trash2 } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { defaultBaseUrlForApiFormat, guessCapability, normalizeChannelModels, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel, type ModelPricing } from "@/stores/use-config-store";
import { formatModelPricingSummary, ModelPricingModal } from "./model-pricing-modal";
import { ModelSelectModal } from "./model-select-modal";

const ModelScriptEditor = lazy(() => import("./model-script-editor").then((m) => ({ default: m.ModelScriptEditor })));

type ScriptTarget = { name: string; capability: ModelCapability; value: string };
type PricingTarget = { name: string; capability: ModelCapability; value?: ModelPricing };

export function ChannelEditorDrawer({
    open,
    channel,
    onSave,
    onClose,
    onFetchModels,
}: {
    open: boolean;
    channel: ModelChannel | null;
    onSave: (channel: ModelChannel) => void;
    onClose: () => void;
    onFetchModels?: (channel: ModelChannel) => Promise<string[]>;
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [scriptTarget, setScriptTarget] = useState<ScriptTarget | null>(null);
    const [pricingTarget, setPricingTarget] = useState<PricingTarget | null>(null);
    const apiFormatOptions: Array<{ label: string; value: ApiCallFormat }> = [
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" },
    ];
    const capabilityOptions: Array<{ label: string; value: ModelCapability }> = ["image", "video", "text", "audio"].map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value: value as ModelCapability }));

    useEffect(() => {
        if (open && channel) setDraft(channel);
    }, [open, channel]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });

    const changeApiFormat = (apiFormat: ApiCallFormat) => {
        const baseUrl = !draft.baseUrl.trim() || draft.baseUrl.trim() === defaultBaseUrlForApiFormat(draft.apiFormat) ? defaultBaseUrlForApiFormat(apiFormat) : draft.baseUrl;
        patch({ apiFormat, baseUrl });
    };

    const applySelection = (names: string[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(names.map((name) => map.get(name) || { name, capability: guessCapability(name) }));
    };

    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability, pricing: undefined } : model)));
    const setScript = (name: string, script: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, script: script || undefined } : model)));
    const setPricing = (name: string, pricing?: ModelPricing) => setModels(draft.models.map((model) => (model.name === name ? { ...model, pricing } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        onSave({
            ...draft,
            name: draft.name.trim() || t("config.channels.unnamed"),
            alias: draft.alias?.trim() || "",
            models: normalizeChannelModels(draft.models),
        });
        onClose();
    };

    return (
        <Drawer
            open={open}
            width={640}
            title={t("config.channelEditor.title")}
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            <div className="grid gap-4 md:grid-cols-3">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder={t("config.channelEditor.namePlaceholder")} />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.alias")}</span>
                    <Input
                        value={draft.alias || ""}
                        onChange={(event) => patch({ alias: event.target.value })}
                        placeholder={t("config.channelEditor.aliasPlaceholder")}
                    />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select className="w-full" value={draft.apiFormat} options={apiFormatOptions} onChange={changeApiFormat} />
                </label>
                <label className="block md:col-span-3">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input value={draft.baseUrl} onChange={(event) => patch({ baseUrl: event.target.value })} placeholder="https://api.example.com" />
                </label>
                <label className="block md:col-span-3">
                    <span className="mb-1 block text-sm font-medium">
                        API Key{draft.hasApiKey && draft.apiKeyPreview ? t("config.channelEditor.apiKeySavedHint", { preview: draft.apiKeyPreview }) : ""}
                    </span>
                    <Input.Password
                        value={draft.apiKey}
                        onChange={(event) => patch({ apiKey: event.target.value })}
                        placeholder={draft.hasApiKey ? t("config.channelEditor.apiKeyKeepPlaceholder") : "sk-..."}
                    />
                </label>
            </div>

            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => setSelectOpen(true)}>
                    {t("config.channelEditor.selectModels")}
                </Button>
            </div>

            <div className="divide-y divide-stone-200 rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="space-y-2 px-3 py-2.5 hover:bg-stone-50 dark:hover:bg-stone-900/40">
                            <div className="flex items-start justify-between gap-3">
                                <span className="min-w-0 flex-1 break-all text-sm font-medium leading-5" title={model.name}>
                                    {model.name}
                                </span>
                                <Tag className="!m-0 shrink-0">{formatModelPricingSummary(model.capability, model.pricing)}</Tag>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <Segmented size="small" value={model.capability} options={capabilityOptions} onChange={(value) => setCapability(model.name, value as ModelCapability)} />
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button size="small" icon={<Coins className="size-3.5" />} onClick={() => setPricingTarget({ name: model.name, capability: model.capability, value: model.pricing })}>
                                        {t("config.channelEditor.pricing")}
                                    </Button>
                                    <Button size="small" icon={<Code2 className="size-3.5" />} type={model.script ? "primary" : "default"} ghost={Boolean(model.script)} onClick={() => setScriptTarget({ name: model.name, capability: model.capability, value: model.script || "" })}>
                                        {t(model.script ? "config.channelEditor.scriptReady" : "config.channelEditor.script")}
                                    </Button>
                                    <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                                </div>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedNames={draft.models.map((model) => model.name)} onConfirm={applySelection} onClose={() => setSelectOpen(false)} onFetchModels={onFetchModels} />

            {scriptTarget ? (
                <Suspense fallback={null}>
                    <ModelScriptEditor
                        open
                        capability={scriptTarget.capability}
                        modelName={scriptTarget.name}
                        value={scriptTarget.value}
                        onSave={(script) => setScript(scriptTarget.name, script)}
                        onClose={() => setScriptTarget(null)}
                    />
                </Suspense>
            ) : null}

            <ModelPricingModal
                open={Boolean(pricingTarget)}
                modelName={pricingTarget?.name || ""}
                capability={pricingTarget?.capability || "text"}
                value={pricingTarget?.value}
                onSave={(pricing) => pricingTarget && setPricing(pricingTarget.name, pricing)}
                onClose={() => setPricingTarget(null)}
            />
        </Drawer>
    );
}
