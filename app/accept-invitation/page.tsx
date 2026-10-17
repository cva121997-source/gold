"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleAlert, ShieldCheck, UserCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function AcceptInvitationPage(){
 const router=useRouter();const [token,setToken]=useState("");const [signedIn,setSignedIn]=useState(false);const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
 useEffect(()=>{setToken(new URLSearchParams(window.location.search).get("token")??"");void(async()=>{try{const {data:{user}}=await createClient().auth.getUser();setSignedIn(Boolean(user));}catch{}finally{setLoading(false)}})()},[]);
 async function accept(e:FormEvent<HTMLFormElement>){e.preventDefault();setError("");setNotice("");if(!token){setError("Invitation token is missing. Open the complete invitation link.");return;}setBusy(true);try{const supabase=createClient();const {data:{user}}=await supabase.auth.getUser();if(!user){router.push("/login");return;}const {error}=await supabase.rpc("accept_staff_invitation",{p_token:token});if(error){setError("Invitation could not be accepted. It may have expired, been used already, or your verified phone/email may not match the invite.");return;}setNotice("Your shop staff access has been activated.");router.push("/dashboard");router.refresh();}catch{setError("Unable to accept this invitation. Check the connection and try again.");}finally{setBusy(false)}}
 return <main><div className="page-wrap" style={{maxWidth:680}}><Link className="link-text small" href="/"><ArrowLeft size={13} style={{display:"inline",verticalAlign:"middle"}}/> Gold home</Link><section className="panel" style={{marginTop:22}}><div className="feature-icon"><UserCheck size={21}/></div><div className="eyebrow">Secure team access</div><h1 style={{marginTop:12,fontSize:34}}>Accept staff invitation</h1><p className="muted" style={{lineHeight:1.7}}>Use the account whose verified email or mobile number matches the intended invitation. The invitation is single-use and expires after seven days.</p>
 {error&&<div role="alert" className="notice" style={{marginBottom:14}}><CircleAlert size={16}/>{error}</div>}{notice&&<div className="notice" style={{marginBottom:14,color:"#1f5c3e",background:"#edf7ef",borderColor:"#cfe4d4"}}>{notice}</div>}
 {loading?<p className="small muted">Checking authentication…</p>:!signedIn?<><p className="small muted">Sign in first using your verified invited contact method. You will need to reopen this invitation link after sign-in.</p><Link className="btn btn-primary" href={"/login"}>Go to sign in</Link></>:<form onSubmit={accept}><div className="field"><label htmlFor="token">Invitation token</label><input id="token" value={token} onChange={e=>setToken(e.target.value)} required autoComplete="off"/></div><button className="btn btn-primary" type="submit" disabled={busy} style={{width:"100%",marginTop:16}}>{busy?"Validating invitation…":<><ShieldCheck size={15}/> Accept invitation</>}</button></form>}
 </section></div></main>;
}
