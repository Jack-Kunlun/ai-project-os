import { SmsProviderAdminClient } from "@/app/admin/sms/sms-provider-admin-client";
import { AdminPageHeader } from "@/components/admin-page-header";

export const dynamic = "force-dynamic";

export default function AdminSmsPage() {
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="短信服务" description="配置短信供应商，管理手机号认证服务。" />
    <SmsProviderAdminClient />
  </div>;
}
