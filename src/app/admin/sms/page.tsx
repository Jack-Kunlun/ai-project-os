import { SmsProviderAdminClient } from "@/app/admin/sms/sms-provider-admin-client";
import { AdminPageHeader } from "@/components/admin-page-header";

export const dynamic = "force-dynamic";

export default function AdminSmsPage() {
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="短信服务供应商" description="管理当前短信供应商；新增或更换配置前须先发送并验证真实测试短信。" />
    <SmsProviderAdminClient />
  </div>;
}
