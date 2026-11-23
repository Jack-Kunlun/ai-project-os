import { expect, type Locator } from "@playwright/test";

const defaults = [
  { kind: "deepseek", text: "deepseek-flash", vision: "deepseek-flash" },
  { kind: "qwen", text: "qwen4-max", vision: "qwen4-max", vector: "qwen3.7-text-embedding", dimensions: "1024" },
  { kind: "glm", text: "glm-5.3", vision: "glm-5.3-flash", vector: "embedding-3", dimensions: "2048" },
  { kind: "openai", text: "gpt-6.2-sol", vision: "gpt-6.2-sol", vector: "text-embedding-3-large", dimensions: "3072" },
];

export async function expectProviderDefaults(form: Locator, personal: boolean) {
  for (const provider of defaults) {
    await form.getByRole("combobox", { name: "供应商", exact: true }).selectOption(provider.kind);
    await expect(form.getByLabel("生成模型（可选）", { exact: true })).toHaveValue(provider.text);
    await expect(form.getByLabel("图片识别模型（可选）", { exact: true })).toHaveValue(provider.vision);
    const vector = form.getByLabel(personal ? "向量模型（可选）" : "向量模型", { exact: true });
    if (provider.vector && provider.dimensions) {
      await expect(vector).toHaveValue(provider.vector);
      await expect(form.getByLabel(personal ? "向量维度（可选）" : "维度", { exact: true })).toHaveValue(provider.dimensions);
    } else if (personal) {
      await expect(vector).toBeDisabled();
    } else {
      await expect(vector).toHaveCount(0);
    }
  }
}
