import { UiText } from "@/components/appearance-provider";
import { requireSystemAdminPage } from "@/lib/system-admin";
import { AdminPageHeader } from "@/components/admin-page-header";
import styles from "@/app/guide/guide-page.module.css";

export default async function AdminGuidePage() {
  await requireSystemAdminPage();
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="管理员操作指南" description="按当前控制面流程完成预算、供应商连接、能力模型和用户治理；未通过真实测试的配置不会被宣称可用。" />
    <div className={`${styles.guideContent} ${styles.adminLayout}`}>
      <nav aria-labelledby="admin-guide-nav-label" className={styles.chapterNav}>
        <span id="admin-guide-nav-label" className="sr-only"><UiText text="管理员指南目录" /></span>
        <ul>
          {[
            ["probe-budget", "1. 先了解模型测试额度"],
            ["provider-connection", "2. 新增供应商：先测试后保存"],
            ["capability-models", "3. 六项能力：选择、测试、启用"],
            ["users-memberships-credits", "4. 用户、会员与额度"],
            ["mcp-audit", "5. MCP 与审计"],
            ["backups-blockers", "6. 备份与常见阻塞"],
          ].map(([id, title], index) => <li key={id}><a href={`#${id}`}><span className={styles.chapterNumber}>{String(index + 1).padStart(2, "0")}</span><span className={styles.chapterTitle}><UiText text={title} /></span></a></li>)}
        </ul>
      </nav>
      <div className={styles.reading}>
      <GuideCard title="1. 先了解模型测试额度" summary="测试额度按外部测试请求次数计，不是平台 Token、人民币费用或供应商余额。" id="probe-budget" steps={["打开模型测试额度，设置最大测试次数和有效至；生效时间与告警阈值位于高级设置。", "保存会立即停用旧周期，旧周期未用次数不结转；系统不会自动补充额度。", "每项能力连通性测试最多计 1 次；供应商连接测试按生成、向量和图片模型计 1–3 次。未知请求保留待核对并占用次数，不会自动重试。"]} success="页面显示当前生效状态、可用次数、已计入、进行中、待核对和有效至。" blockers="额度未设置、已耗尽、待生效或过期；先核对周期状态，不要因未知结果自动重发。" href="/admin/operations/probes" linkLabel="打开模型测试额度" />
      <GuideCard title="2. 新增供应商：先测试后保存" summary="新增连接必须先用真实凭据测试，测试证据通过后才能保存。" id="provider-connection" steps={["在平台模型页点击“新增供应商”，填写固定供应商、端点、模型和 API Key。", "点击“测试连接”，等待指定能力返回成功证据。", "确认测试仍在有效期内后保存连接；API Key 不会写入浏览器存储或响应。"]} success="测试状态为成功且保存按钮可用，连接出现在已配置连接列表。" blockers="模型测试额度未设置或不足、端点或凭据错误、测试证据过期；修正表单后重新测试。" href="/admin/models" linkLabel="打开平台模型" />
      <GuideCard title="3. 六项能力：选择、测试、启用" summary="先勾选要配置的能力，再批量测试并启用；未选择的能力保持原配置。" id="capability-models" steps={["在模型与能力页面勾选要配置的能力，可一键全选；也可为所选文字能力统一指定模型。", "点击“测试并启用所选”，系统逐项测试，成功项立即启用，失败项保留原配置；或点击“仅测试”，通过项的测试结果可在 5 分钟内用于启用。", "只对已知失败项显式重新测试。结果未知的请求会保留待确认状态，不会自动重试；向量模型变更时先确认影响。"]} success="所选能力的测试与启用结果逐项显示；成功项生效，失败项仍使用原配置。" blockers="模型未验证、供应商已停用、能力类型不匹配或向量维度冲突；先修正连接或模型，再显式重新测试。" href="/admin/models" linkLabel="打开能力配置" />
      <GuideCard title="4. 用户、会员与额度" summary="三个入口职责不同：用户看账号总览，会员处理资格，额度处理余额。" id="users-memberships-credits" steps={["在用户页搜索并打开账号详情，处理账号启用/停用和摘要。", "在会员页处理申请、授予或延期会员资格。", "在额度页生成补发/撤销预览，核对后输入用户名确认执行。"]} success="页面显示最新状态，危险操作有预览、版本校验和对应审计记录。" blockers="账号已停用、版本已变化、存在活动预留或预览已过期；重新读取后再操作。" href="/admin/users" linkLabel="打开用户运营" />
      <GuideCard title="5. MCP 与审计" summary="安全操作先审核，再从审计记录确认事实，不绕过当前只读授权边界。" id="mcp-audit" steps={["在 MCP 审核工作台查看连接、工具和最小权限证据。", "按页面提示批准或拒绝当前审核项。", "打开审计记录确认事件、操作者、结果和安全码。"]} success="审核项有明确结果，审计记录包含可追溯的变更证据。" blockers="缺少工具认证、证据过期或请求超出只读范围；补齐证据或保持拒绝。" href="/admin/connectors/mcp" linkLabel="打开 MCP 审核" />
      <GuideCard title="6. 备份与常见阻塞" summary="运维页面用于确认备份、失败任务和服务状态，不能代替业务配置。" id="backups-blockers" steps={["先查看备份状态和最近成功时间。", "再查看失败收件箱与应用、数据库、Worker 健康状态。", "遇到安全码时按对应页面重新执行前置步骤，不提交过期证明。"]} success="最近备份有可验证时间，关键服务健康，失败项有明确处理结果。" blockers="备份缺失、Worker 不健康、模型测试额度未设置、能力未配置或连接已停用；先处理对应阻塞再继续。" href="/admin/operations/backups" linkLabel="打开备份状态" />
      </div>
    </div>
  </div>;
}

function GuideCard({ id, title, summary, steps, success, blockers, href, linkLabel }: { id: string; title: string; summary: string; steps: readonly string[]; success: string; blockers: string; href: string; linkLabel: string }) {
  return <article id={id} className={styles.chapter}>
    <h2 className={styles.adminHeading}><UiText text={title} /></h2>
    <p className={styles.adminSummary}><UiText text={summary} /></p>
    <div className={styles.adminDetails}>
      <div>
        <h3><UiText text={"操作步骤"} /></h3>
        <ol>{steps.map((step) => <li key={step}><UiText text={step} /></li>)}</ol>
      </div>
      <p><strong><UiText text={"成功条件："} /></strong><UiText text={success} /></p>
      <p><strong><UiText text={"常见阻塞："} /></strong><UiText text={blockers} /></p>
    </div>
    <a href={href} className={styles.adminLink}><UiText text={linkLabel} /> <span aria-hidden="true">→</span></a>
  </article>;
}
