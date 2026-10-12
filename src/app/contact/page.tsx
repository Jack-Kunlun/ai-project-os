import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";

export const metadata: Metadata = { title: "联系作者 · AI Project OS" };

export default function ContactPage() {
  return (
    <PublicInfoPage eyebrow="Contact" title="联系作者" description="使用反馈、问题建议，欢迎通过微信联系。">
      <div className="grid items-start gap-8 md:grid-cols-2">
        <figure className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <Image
            src="/contact/author-wechat.jpg"
            alt="作者的微信名片，包含添加好友二维码"
            width={888}
            height={1131}
            unoptimized
            className="h-auto w-full"
          />
          <figcaption className="border-t border-slate-100 px-4 py-3 text-center text-xs text-slate-500">使用微信扫描二维码，添加作者为好友。</figcaption>
        </figure>
        <div className="space-y-7 self-center">
          <InfoSection title="微信交流">
            <p>欢迎分享 AI Project OS 的使用体验、反馈遇到的问题或提出改进建议。</p>
            <p>电脑访问时，可用手机微信扫描页面中的二维码；手机访问时，可保存二维码图片，再通过微信识别。</p>
            <div className="flex flex-wrap gap-3 pt-1">
              <a href="/contact/author-wechat.jpg" download="AI-Project-OS-作者微信.jpg" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">保存二维码</a>
              <a href="/contact/author-wechat.jpg" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">查看原图<span className="sr-only">（在新窗口打开）</span></a>
            </div>
          </InfoSection>
          <InfoSection title="需要使用帮助？">
            <p>常见登录问题可以先查看帮助文档；登录工作区后可查看完整操作指南。</p>
            <div className="flex flex-wrap gap-4 pt-1">
              <Link href="/help" className="font-semibold text-indigo-600 hover:text-indigo-700">查看帮助文档 →</Link>
              <Link href="/guide" className="font-semibold text-indigo-600 hover:text-indigo-700">打开操作指南 →</Link>
            </div>
          </InfoSection>
        </div>
      </div>
    </PublicInfoPage>
  );
}
