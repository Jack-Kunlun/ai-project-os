import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { DATABASE_PRINCIPAL_RELATIONS, ENTITLEMENT_PROTECTED_RELATIONS } from "@/lib/database-principal-catalog";
async function main() {
const exec=promisify(execFile);
const image="pgvector/pgvector:0.8.6-pg18-trixie@sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff";
const container=`ai-project-os-phone-auth-${randomUUID().slice(0,8)}`;
const secret=randomBytes(24).toString("hex");
const port=56329, database="ai_project_os_phone_auth_test";
const url=(role:string)=>`postgresql://${role}:${secret}@127.0.0.1:${port}/${database}`;
const admin=new Client({connectionString:url("phone_auth_cluster")});
const owner=new Client({connectionString:url("ai_project_os_migrator")});
let started=false, adminOpen=false, ownerOpen=false;
const temporary=await mkdtemp(join(tmpdir(),"ai-project-os-phone-auth-"));
async function command(file:string,args:string[],env:NodeJS.ProcessEnv=process.env):Promise<string>{
 const result=await exec(file,args,{env,timeout:300_000,maxBuffer:4*1024*1024});return result.stdout;
}
try {
 await command("docker",["image","inspect",image]);
 await command("docker",["run","--detach","--pull=never","--name",container,"--publish",`127.0.0.1:${port}:5432`,"--env",`POSTGRES_PASSWORD=${secret}`,"--env","POSTGRES_USER=phone_auth_cluster","--env",`POSTGRES_DB=${database}`,image]);started=true;
 for(let i=0;i<40;i++){
  try{await command("docker",["exec",container,"pg_isready","-h","127.0.0.1","-U","phone_auth_cluster","-d",database]);break;}catch{if(i===39)throw new Error("PHONE_AUTH_DATABASE_NOT_READY");await new Promise(r=>setTimeout(r,250));}
 }
 await admin.connect();adminOpen=true;
 for(const role of ["ai_project_os_migrator","ai_project_os_runtime","ai_project_os_entitlement_writer"]){
  // Fixed identifiers and a generated hex-only password, never user input.
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`);
 }
 await admin.query(`ALTER DATABASE "${database}" OWNER TO ai_project_os_migrator`);
 await admin.query("CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto; ALTER SCHEMA public OWNER TO ai_project_os_migrator");
 await command("pnpm",["exec","prisma","migrate","deploy","--config","prisma.config.ts"],{...process.env,DATABASE_URL:url("ai_project_os_migrator")});
 await owner.connect();ownerOpen=true;
 const directories=(await readdir("prisma/migrations",{withFileTypes:true})).filter(x=>x.isDirectory());
 console.log(`PHONE_AUTH_MIGRATIONS_OK count=${directories.length}`);
 // Exercise the new relations' reviewed principal policy. This is a targeted
 // gate, not the separate full database-principal/OID10 release gate.
 await owner.query("GRANT USAGE ON SCHEMA public TO ai_project_os_runtime,ai_project_os_entitlement_writer; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ai_project_os_entitlement_writer; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_project_os_entitlement_writer; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_project_os_runtime; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ai_project_os_entitlement_writer");
 for(const relation of ENTITLEMENT_PROTECTED_RELATIONS){
  if(!(DATABASE_PRINCIPAL_RELATIONS as readonly string[]).includes(relation))throw new Error("PHONE_AUTH_UNCATALOGUED_RELATION");
  const result=await owner.query("SELECT has_table_privilege('ai_project_os_runtime',$1,'INSERT') AS insert,has_table_privilege('ai_project_os_runtime',$1,'UPDATE') AS update,has_table_privilege('ai_project_os_runtime',$1,'DELETE') AS delete",[`public."${relation}"`]);
  if(Object.values(result.rows[0]).some(Boolean))throw new Error("PHONE_AUTH_RUNTIME_WRITE_ALLOWED");
 }
 const keydir=join(temporary,"keys");await mkdir(keydir,{mode:0o700});
 const files=["test/phone-auth-postgres.test.ts","test/sms-provider-admin-postgres.test.ts","test/sms-provider-adapters-postgres.test.ts","test/account-closure-postgres.test.ts","test/graphic-captcha-postgres.test.ts","test/account-security-postgres.test.ts"];
 for(const file of files)await readFile(file);
 const output=await command(process.execPath,["--import","tsx","--test","--test-concurrency=1",...files],{
 ...process.env,PHONE_AUTH_POSTGRES_GATE:"1",PHONE_AUTH_TEST_DATABASE_URL:url("ai_project_os_entitlement_writer"),PHONE_AUTH_TEST_OWNER_URL:url("ai_project_os_migrator"),DATABASE_URL:url("ai_project_os_runtime"),ENTITLEMENT_DATABASE_URL:url("ai_project_os_entitlement_writer"),LOCAL_REGISTRATION_ENABLED:"true",PHONE_AUTH_ENABLED:"true",PHONE_AUTH_SECRET:randomBytes(32).toString("base64url"),AI_PROJECT_OS_MASTER_KEY_FILE:join(keydir,"master.key"),AI_PROJECT_OS_PUBLIC_ORIGIN:"https://phone-auth.example.com",
 });console.log(output.trim());console.log("PHONE_AUTH_POSTGRES_GATE_OK");
} catch(error){
 if(error && typeof error==="object" && "stdout" in error) console.error(String(error.stdout).replaceAll(secret,"[redacted]"));
 console.error(error instanceof Error ? error.message.replaceAll(secret,"[redacted]").replace(/postgres(?:ql)?:\/\/[^\s]+/gu,"[database-url]") : "PHONE_AUTH_GATE_FAILED");process.exitCode=1;
} finally {
 if(ownerOpen)await owner.end();if(adminOpen)await admin.end();
 if(started)await command("docker",["rm","--force","--volumes",container]).catch(()=>{process.exitCode=1;console.error("PHONE_AUTH_CONTAINER_CLEANUP_FAILED");});
 await rm(temporary,{recursive:true,force:true});
}

}
void main().catch(() => { console.error("PHONE_AUTH_GATE_SETUP_FAILED"); process.exitCode=1; });
