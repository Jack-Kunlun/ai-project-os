"use client";
import Link from "next/link";
import { useEffect,useRef,useState } from "react";
import { LogoutButton } from "@/app/logout-button";
import { useTranslate } from "./appearance-provider";
export function HeaderAccount({username,isSystemAdmin=false,accountHref="/profile"}:{username:string;isSystemAdmin?:boolean;accountHref?:string}){
 const t=useTranslate(),[open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(!open)return;function outside(e:PointerEvent){if(!root.current?.contains(e.target as Node))setOpen(false);}function key(e:KeyboardEvent){if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}}document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};},[open]);
 return <div className="header-account" ref={root}><button ref={trigger} className="header-avatar" aria-label={t('账户菜单')} title={t('账户菜单')} aria-expanded={open} onClick={()=>setOpen(!open)}>{username.slice(0,1).toUpperCase()}</button>{open?<div className="header-account-popover"><strong>{username}</strong><Link href={accountHref} onClick={()=>setOpen(false)}>{t('账户设置')}</Link>{isSystemAdmin?<Link href="/admin" onClick={()=>setOpen(false)}>{t('平台管理')}</Link>:null}<LogoutButton className="account-signout"/></div>:null}</div>;
}
