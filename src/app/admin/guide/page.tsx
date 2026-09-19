import { requireSystemAdminPage } from "@/lib/system-admin";
import { AdminPageHeader } from "@/components/admin-page-header";

export default async function AdminGuidePage() {
  await requireSystemAdminPage();
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="管理员操作指南" description="按当前控制面流程完成预算、供应商连接、能力模型和用户治理；未通过真实测试的配置不会被宣称可用。" />
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <GuideCard title="1. 先准备探测预算" summary="连接测试会产生外部请求，先为本周期准备可用的探测预算。" steps={["打开探测预算，填写单位上限、告警阈值和有效期。", "提交新的预算周期并确认页面显示有效状态。"]} success="页面显示“已启用”，且可用单位和有效期均有明确数值。" blockers="没有有效周期、预算已耗尽或周期已过期；先更新预算，不要重复提交旧测试。" href="/admin/operations/probes" linkLabel="打开探测预算" />
      <GuideCard title="2. 新增供应商：先测试后保存" summary="新增连接必须先用真实凭据测试，测试证据通过后才能保存。" steps={["在平台模型页点击“新增供应商”，填写固定供应商、端点、模型和 API Key。", "点击“测试连接”，等待指定能力返回成功证据。", "确认测试仍在有效期内后保存连接；API Key 不会写入浏览器存储或响应。"]} success="测试状态为成功且保存按钮可用，连接出现在已配置连接列表。" blockers="探测预算未启用/不足、端点或凭据错误、测试证据过期；修正表单后重新测试。" href="/admin/models" linkLabel="打开平台模型" />
      <GuideCard title="3. 六项能力：选择、测试、启用" summary="每个能力单独选择可用模型，不能用路由草稿代替能力配置。" steps={["在六张能力卡中选择已验证的供应商与模型。", "针对能力、模型和参数执行真实测试，尤其确认向量维度等兼容项。", "测试通过后保存并启用；未选择的能力不自动改动已有配置。"]} success="能力卡显示已配置、已验证并处于启用状态，后续调用能找到对应模型。" blockers="模型未验证、供应商已停用、能力类型不匹配或向量维度冲突；返回连接或能力卡修正。" href="/admin/models" linkLabel="打开能力配置" />
      <GuideCard title="4. 用户、会员与额度" summary="三个入口职责不同：用户看账号总览，会员处理资格，额度处理余额。" steps={["在用户页搜索并打开账号详情，处理账号启用/停用和摘要。", "在会员页处理申请、授予或延期会员资格。", "在额度页生成补发/撤销预览，核对后输入用户名确认执行。"]} success="页面显示最新状态，危险操作有预览、版本校验和对应审计记录。" blockers="账号已停用、版本已变化、存在活动预留或预览已过期；重新读取后再操作。" href="/admin/users" linkLabel="打开用户运营" />
      <GuideCard title="5. MCP 与审计" summary="安全操作先审核，再从审计记录确认事实，不绕过当前只读授权边界。" steps={["在 MCP 审核工作台查看连接、工具和最小权限证据。", "按页面提示批准或拒绝当前审核项。", "打开审计记录确认事件、操作者、结果和安全码。"]} success="审核项有明确结果，审计记录包含可追溯的变更证据。" blockers="缺少工具认证、证据过期或请求超出只读范围；补齐证据或保持拒绝。" href="/admin/connectors/mcp" linkLabel="打开 MCP 审核" />
      <GuideCard title="6. 备份与常见阻塞" summary="运维页面用于确认备份、失败任务和服务状态，不能代替业务配置。" steps={["先查看备份状态和最近成功时间。", "再查看失败收件箱与应用、数据库、Worker 健康状态。", "遇到安全码时按对应页面重新执行前置步骤，不提交过期证明。"]} success="最近备份有可验证时间，关键服务健康，失败项有明确处理结果。" blockers="备份缺失、Worker 不健康、探测预算未启用、能力未配置或连接已停用；先处理对应阻塞再继续。" href="/admin/operations/backups" linkLabel="打开备份状态" />
    </div>
  </div>;
}

function GuideCard({ title, summary, steps, success, blockers, href, linkLabel }: { title: string; summary: string; steps: readonly string[]; success: string; blockers: string; href: string; linkLabel: string }) {
  return <article className="flex flex-col rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm">
    <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">{summary}</p>
    <div className="mt-4 space-y-3 text-xs leading-5 text-slate-600">
      <div>
        <h3 className="font-semibold text-slate-800">操作步骤</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5">{steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </div>
      <p><span className="font-semibold text-emerald-700">成功条件：</span>{success}</p>
      <p><span className="font-semibold text-amber-700">常见阻塞：</span>{blockers}</p>
    </div>
    <a href={href} className="mt-5 inline-flex w-fit items-center rounded-xl border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">{linkLabel} <span aria-hidden="true" className="ml-2">→</span></a>
  </article>;
}
