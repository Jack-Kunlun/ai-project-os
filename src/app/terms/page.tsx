import type { Metadata } from "next";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";

export const metadata: Metadata = { title: "服务条款 · AI Project OS" };

export default function TermsPage() {
  return (
    <PublicInfoPage eyebrow="Terms" title="服务条款" description="AI Project OS 提供可审阅的项目协作与知识治理能力。使用前请确认你已获得对应工作区、项目资料、仓库和外部服务的访问授权。">
      <InfoSection title="授权使用">
        <p>你只能在所属组织允许的范围内使用系统，并应确保上传资料、连接仓库、调用模型或只读工具时拥有必要权限。不得把他人的密码、Token 或未获授权的敏感数据录入项目资料。</p>
      </InfoSection>
      <InfoSection title="人工确认责任">
        <p>AI 抽取、简报和建议属于辅助结果，不会自动成为已确认事实。用户应核对来源、引用、权限和影响后再确认资料、推进计划或批准受控动作。</p>
      </InfoSection>
      <InfoSection title="能力限制">
        <p>系统不提供任意 Shell、自动代码修改、Git 写入或自动部署能力。外部服务的可用性、速率、费用与数据处理仍受对应服务条款和当前部署配置影响。</p>
      </InfoSection>
      <InfoSection title="版本与部署验证">
        <p>功能、接口和数据结构会随版本演进。工作区管理员应在升级、备份、恢复和对外使用前，依据自身环境完成必要验证，并根据部署配置说明可用范围；系统页面或协议中的版本号用于诊断、兼容性和问题定位，不构成对特定部署可用性或生产服务等级的承诺。</p>
      </InfoSection>
    </PublicInfoPage>
  );
}
