"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { UiText, useAppearance } from "@/components/appearance-provider";
import { UiErrorText } from "@/components/ui-error-text";
import { ShellIcon } from "@/components/shell-icon";
import { safeResponseError } from "@/lib/safe-error-presentation";
import ui from "@/components/workspace-ui.module.css";
import styles from "./personal-model-overview.module.css";

type Provider = { name:string; modelId?:string; defaultEmbeddingModelId?:string; billingMode:string };
type Summary = { totalCredits:number; availableCredits:number; usedCredits:number };
const kinds=[['生成与问答','qa'],['图像识别','vision'],['语义向量','semantic']] as const;

/** Display existing, owner-scoped read endpoints; this never tests or calls a model. */
export function PersonalModelOverview({children}:{children:ReactNode}) {
  const {t,language}=useAppearance();
  const [models,setModels]=useState<Record<string,Provider|null>>({});
  const [summary,setSummary]=useState<Summary|null>(null);
  const [errors,setErrors]=useState<string[]>([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    void Promise.allSettled([
      ...kinds.map(async([,kind])=>{
        const response=await fetch(`/api/personal/knowledge/${kind}-providers`,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error((await safeResponseError(response,'平台模型信息加载失败')).message);
        const data=await response.json() as {providers?:Provider[]};
        if(!Array.isArray(data.providers))throw new Error('平台模型信息加载失败');
        return [kind,data.providers.find(provider=>provider.billingMode==='platform')??null] as const;
      }),
      (async()=>{
        const response=await fetch('/api/credits?range=7d&timezone=UTC&page=1&pageSize=1',{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw new Error((await safeResponseError(response,'额度信息加载失败')).message);
        const data=await response.json() as {report?:{summary?:Summary}};
        const value=data.report?.summary;
        if(!value || ![value.totalCredits,value.availableCredits,value.usedCredits].every(number=>typeof number==='number'&&Number.isFinite(number)&&number>=0))throw new Error('额度信息加载失败');
        return ['credits',value] as const;
      })(),
    ]).then(results=>{
      if(controller.signal.aborted)return;
      const next:Record<string,Provider|null>={},failures:string[]=[];
      for(const result of results){
        if(result.status==='rejected'){failures.push(result.reason instanceof Error?result.reason.message:'平台模型信息加载失败');continue;}
        const [kind,value]=result.value;
        if(kind==='credits')setSummary(value as Summary);else next[kind]=value as Provider|null;
      }
      setModels(next);setErrors([...new Set(failures)]);setLoading(false);
    });
    return()=>controller.abort();
  },[]);
  const number=(value:number)=>new Intl.NumberFormat(language==='en'?'en-US':'zh-CN').format(value);
  const used=summary&&summary.totalCredits>0?Math.min(100,Math.max(0,summary.usedCredits/summary.totalCredits*100)):0;
  return <div className={styles.overview} aria-busy={loading} data-model-overview>
    <section className={styles.banner}><span className={styles.symbol} aria-hidden="true"><ShellIcon name="spark" className="app-icon--feature"/></span><div><h2><UiText text="平台默认模型"/></h2><p><UiText text="无需填写 API Key。每次调用仍需核对模型、输入范围与额度。"/></p></div></section>
    <div className={styles.capabilities}>{kinds.map(([label,kind])=><section key={kind}><h3>{t(label)}</h3><p><ShellIcon name={models[kind]?'checkcircle':'circle'} className="app-icon--compact"/><span>{loading?t('读取中…'):models[kind]?`${models[kind]!.name} · ${models[kind]!.modelId??models[kind]!.defaultEmbeddingModelId??''}`:t(kind in models?'未配置':'暂时无法读取')}</span></p></section>)}</div>
    {errors.map(error=><p key={error} className={ui.error} role="alert"><UiErrorText text={error}/></p>)}
    <div className={styles.columns}><section className={styles.quota}><header><h2><UiText text="我的平台额度"/></h2><Link href="/personal/usage" className={ui.link}><UiText text="使用记录"/><ShellIcon name="arrow" className="app-icon--compact"/></Link></header><strong>{summary?number(summary.availableCredits):'—'}<small><UiText text="平台额度"/></small></strong><div className={styles.track} aria-hidden="true"><span style={{width:`${100-used}%`}}/></div><p>{summary?<>{t('已使用')} {number(summary.usedCredits)} · {t('累计发放')} {number(summary.totalCredits)}</>:t(loading?'读取中…':'暂时无法读取')}</p></section><section className={styles.personal}>{children}</section></div>
  </div>;
}
