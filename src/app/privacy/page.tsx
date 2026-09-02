import type { Metadata } from "next";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";

export const metadata: Metadata = { title: "隐私政策 · AI Project OS" };

export default function PrivacyPage() {
  return (
    <PublicInfoPage eyebrow="Privacy" title="隐私政策" description="说明 AI Project OS 当前如何处理账号、项目资料、凭据与模型传输。实际数据位置和保留周期由部署该系统的工作区管理员负责配置与说明。">
      <InfoSection title="收集与保存的内容">
        <p>系统会保存登录账号、工作区与项目权限、用户主动录入或上传的项目资料、审核记录、运行记录和审计信息，以提供可追溯的项目管理能力。</p>
      </InfoSection>
      <InfoSection title="外部处理边界">
        <p>项目内容不会仅因进入系统而自动发送给模型供应商。需要模型处理的页面会显示具体范围，并要求有权限的用户在当次操作前确认；只读 Git、网页和 MCP 连接也受项目授权与服务端策略约束。</p>
      </InfoSection>
      <InfoSection title="凭据与访问控制">
        <p>模型、Git、OIDC 与其他连接凭据只通过认证后的同源接口接收并加密保存，页面和普通 API 不返回凭据明文。项目数据按工作区和项目权限隔离。</p>
      </InfoSection>
      <InfoSection title="查询、导出与删除">
        <p>有权限的用户可以在产品内查看项目资料和审计记录，并按现有项目管理能力导出或删除项目。删除、备份恢复和日志保留的实际执行范围由工作区部署策略决定。</p>
      </InfoSection>
    </PublicInfoPage>
  );
}
