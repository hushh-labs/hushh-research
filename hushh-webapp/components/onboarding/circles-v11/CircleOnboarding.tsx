'use client';
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import React, {useCallback,useEffect,useId,useRef,useState} from 'react';
import Image from 'next/image';
import {BadgeCheck} from '@/components/icons';
import {AddPeopleAction} from '@/components/app-ui/add-people-action';
import {GoogleIcon} from '@/lib/morphy-ux/social-icons';
import type {CircleOnboardingProps,OnboardingPerson,ViewName} from './types';
import {Icon} from './Icons';
import {CircleScene} from './CircleScene';
import './circles.css';

function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map(word=>word[0]?.toUpperCase()).join('')||'?';}

function PersonAvatar({person}:{person:OnboardingPerson}){
 const [imageFailed,setImageFailed]=useState(false);
 const Root = person.isSelf ? "span" : "button";
 return <Root type={person.isSelf ? undefined : "button"} aria-label={person.isSelf ? undefined : `View ${person.displayName}'s profile`} onClick={person.isSelf ? undefined : event=>{event.preventDefault();event.stopPropagation();openPersonProfilePreview({userId:person.userId},event.currentTarget);}} className="oc-person-avatar">{person.photoUrl && !imageFailed ? <Image src={person.photoUrl} alt="" width={42} height={42} unoptimized referrerPolicy="no-referrer" onError={()=>setImageFailed(true)}/> : initials(person.displayName)}{person.isRia?<span className="oc-person-verified" aria-label="Verified advisor"><BadgeCheck size={13} aria-hidden="true"/></span>:null}</Root>;
}

function ActionRow({icon,tone,title,description,trailing,onClick,disabled=false}: {icon:'users'|'trusted'|'invite';tone:'blue'|'rose'|'amber';title:string;description:string;trailing:string;onClick:()=>void;disabled?:boolean}){
 return <button className="oc-action-row" type="button" onClick={onClick} disabled={disabled} aria-label={`${title}, ${trailing}`}>
    <span className={`oc-row-icon oc-row-icon--${tone}`}><Icon name={icon} size={22}/></span>
    <span className="oc-row-copy"><strong>{title}</strong><small>{description}</small></span>
    <span className="oc-row-trailing">{trailing}<Icon name="arrow" size={15}/></span>
  </button>;
}

/** The host owns circle, contact, invite, and route mutations. */
export function CircleOnboarding(props:CircleOnboardingProps){
 const {displayName,members=[],rosterMembers=members,trustedMembers=[],circleReady=false,circleName='Contacts',source='google',canFindContacts=false,matching=false,matchCount=null,preview=false,busy=false,assetBaseUrl='/circles',assetMap,theme='auto',layout='auto',className=''}=props;
 const [localView,setLocalView]=useState<ViewName>('home');
 const view=props.view??localView;
 const onViewChangeRef=useRef(props.onViewChange);
 useEffect(()=>{onViewChangeRef.current=props.onViewChange;},[props.onViewChange]);
 const controlled=props.view!==undefined;
 const setView=useCallback((next:ViewName)=>{onViewChangeRef.current?.(next);if(!controlled)setLocalView(next);},[controlled]);
 const [notice,setNotice]=useState('');
 const [localBusy,setLocalBusy]=useState(false);
 const [finished,setFinished]=useState(false);
 const [removeTarget,setRemoveTarget]=useState<OnboardingPerson|null>(null);
 const [confirmBusy,setConfirmBusy]=useState(false);
 const dialogRef=useRef<HTMLDivElement>(null);
 const openerRef=useRef<HTMLElement|null>(null);
 const sheetHeadingId=useId();
 const actionBusy=busy||localBusy;
 const announce=(message:string)=>setNotice(message);
 const invoke=useCallback(async(fn?:()=>void|Promise<unknown>,fallback='Try again later.')=>{
   if(!fn){announce(fallback);return;}
   setLocalBusy(true);
   try { await fn(); }
   catch{announce('Something went wrong. Please try again.');}
   finally{setLocalBusy(false);}
 },[]);
 const open=(next:ViewName)=>{
   if(actionBusy)return;
   setNotice('');
   if(view==='home') openerRef.current=document.activeElement as HTMLElement;
   setView(next);
 };
 const close=useCallback(()=>{if(actionBusy||confirmBusy)return;setView('home');setRemoveTarget(null);setNotice('');},[actionBusy,confirmBusy,setView]);
 useEffect(()=>{
   if(view==='home') { openerRef.current?.focus?.(); return; }
   if(props.nestedDialogOpen)return;
   const id=requestAnimationFrame(()=>dialogRef.current?.querySelector<HTMLElement>('button')?.focus({preventScroll:true}));
   const key=(e:KeyboardEvent)=>{
     if(e.key==='Escape'){e.preventDefault();close();return;}
     if(e.key!=='Tab'||!dialogRef.current)return;
     const items=[...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled])')].filter(x=>x.getClientRects().length>0);
     if(!items.length)return;
     const first=items[0]!,last=items[items.length-1]!;
     if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}
     if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
   };
   document.addEventListener('keydown',key);
   return()=>{cancelAnimationFrame(id);document.removeEventListener('keydown',key);};
 },[view,props.nestedDialogOpen,close]);
 const doContinue=async()=>{if(actionBusy)return;setLocalBusy(true);setNotice('');try{await props.onContinue();if(preview)setFinished(true);}catch{announce('Couldn’t continue. Please try again.');}finally{setLocalBusy(false);}};
 const sourceLabel=source==='device'?'Find people from my phone':'Find people with Google Contacts';
 const greeting=displayName?.trim().split(/\s+/)[0];
 const summary=matching?'We’re checking your contacts. You can continue at any time.':
   typeof matchCount==='number'&&matchCount>0?`${matchCount} ${matchCount===1?'person you know is':'people you know are'} already on One.`:
   members.length>0?`${members.length} ${members.length===1?'person you know is':'people you know are'} already on One.`:
   'Bring your people along, whenever you’re ready.';
 const mascot=assetMap?.answering??`${assetBaseUrl.replace(/\/$/,'')}/answering-poster.png`;
 if(finished) return <div className={`oc-root oc-${theme} oc-${layout} ${className}`} data-theme={theme} data-layout={layout} data-screen="finished"><section className="oc-finished">
   <span className="oc-done-icon"><Icon name="check" size={26}/></span><h1>Ready for One.</h1><p>The preview ends here. In your app, this action opens One.</p>
   {preview?<button className="oc-button oc-button--primary" onClick={()=>setFinished(false)}>Review again <Icon name="arrow" size={18}/></button>:null}
 </section></div>;
 const rowItems=[
  {icon:'users' as const,tone:'blue' as const,title:circleName,description:circleReady?'See who’s in your shared circle.':'Your shared circle is being prepared.',trailing:'Manage',fn:()=>open('contacts'),disabled:!circleReady},
  {icon:'trusted' as const,tone:'rose' as const,title:'Trusted',description:'Choose the people closest to you.',trailing:'Choose',fn:()=>open('trusted')},
  {icon:'invite' as const,tone:'amber' as const,title:'Invite someone',description:'Bring someone new to One.',trailing:'Invite',fn:()=>open('invite')},
 ];
 return <div className={`oc-root oc-${theme} oc-${layout} ${className}`} data-theme={theme} data-layout={layout} data-screen="welcome" data-testid="circle-onboarding">
   <div className="oc-stage">
     <section className="oc-art" aria-label="Agent One illustration"><CircleScene src={mascot}/></section>
     <section className="oc-content" aria-label="Set up your people">
       <header className="oc-head"><h1>Welcome to One{greeting?`, ${greeting}`:''}<span className="oc-dot">.</span></h1><p>{summary}</p></header>
       {members.length>0?<div className="oc-connected"><div className="oc-connected-avatars">{members.slice(0,3).map(person=><PersonAvatar key={person.userId} person={person}/>)}</div><div><strong>People you know</strong><span>{matchCount??members.length} already on One</span></div><button onClick={()=>open('contacts')} type="button">See all <Icon name="arrow" size={16}/></button></div>:null}
       <div className="oc-choices" aria-label="Circle options">{rowItems.map((item,i)=><ActionRow key={i} {...item} onClick={item.fn} disabled={item.disabled}/>)}</div>
       {props.overflowCount?<p className="oc-status">{props.overflowCount} more people are connected. Contacts holds 99 people plus you.</p>:null}
       {props.statusMessage?<p className="oc-status" role="status">{props.statusMessage}</p>:null}
       {props.circleError?<div className="oc-status" role="status">{props.circleError} <button type="button" onClick={()=>void invoke(props.onRetryCircle)}>Retry circle setup</button></div>:null}
       {canFindContacts?<button className="oc-find-link" type="button" disabled={actionBusy} onClick={()=>open('find')}>{source==='device'?<Icon name="phone" size={19} strokeWidth={2}/>:<GoogleIcon size={19}/>} {sourceLabel}<Icon name="arrow" size={17}/></button>:null}
       <div className="oc-footer"><button className="oc-button oc-button--primary" type="button" disabled={actionBusy} onClick={()=>void doContinue()}>{actionBusy?'One moment…':'Continue to One'}<Icon name="arrow" size={19}/></button>
       {preview?<p className="oc-preview-note">Interactive preview. No contacts or accounts are accessed.</p>:null}
       </div>
     </section>
   </div>
   {view!=='home'?<div className="oc-scrim" onPointerDown={(e)=>{if(e.target===e.currentTarget)close();}}><section className="oc-sheet" role="dialog" aria-modal="true" aria-labelledby={sheetHeadingId} ref={dialogRef} data-view={view}>
    <div className="oc-sheet-grabber" aria-hidden="true"/><div className="oc-sheet-top"><button type="button" className="oc-sheet-back" aria-label="Close details" onClick={close} disabled={actionBusy}><Icon name="back" size={19}/></button><span className="oc-sheet-step">YOUR PEOPLE</span><span className="oc-sheet-top-spacer"/></div>
    {view==='contacts'?<div className="oc-sheet-body"><h2 id={sheetHeadingId}>{circleName}</h2><p className="oc-panel-lede">Members can see each other. Your saved info stays separate.</p>
      {!circleReady||props.membersLoading?<div className="oc-empty"><Icon name="loading" size={28}/><strong>{circleReady?'Loading people':'Preparing your circle'}</strong></div>:rosterMembers.some(person=>!person.isSelf)?<div className="oc-person-list">{rosterMembers.map(person=><div className="oc-person-row" key={person.userId}><PersonAvatar person={person}/><span className="oc-person-name" dir="auto">{person.displayName}</span>{person.isSelf?<span className="oc-muted-label">You</span>:props.canManageCircle&&(props.onRequestRemoveMember||props.onRemoveMember)?<button type="button" onClick={()=>props.onRequestRemoveMember?props.onRequestRemoveMember(person):setRemoveTarget(person)}>Remove</button>:null}</div>)}</div>:<div className="oc-empty"><span className="oc-empty-icon oc-empty-icon--blue"><Icon name="users" size={32}/></span><strong>No people here yet</strong><p>When you connect with people on One, you can see them here.</p></div>}
      {props.hasMoreMembers&&!props.membersLoading?<button className="oc-button oc-button--quiet" disabled={actionBusy} onClick={()=>void invoke(props.onLoadMoreMembers)}>Load more people</button>:null}
      <button className="oc-button oc-button--primary" type="button" onClick={()=>open('invite')} disabled={actionBusy}>Invite someone <Icon name="arrow" size={18}/></button>
      {props.canInviteMembers?<AddPeopleAction onClick={()=>void invoke(props.onChooseContacts)} disabled={actionBusy||props.circleFull}>Add people already on One</AddPeopleAction>:null}
    </div>:null}
    {view==='trusted'?<div className="oc-sheet-body"><h2 id={sheetHeadingId}>Your trusted people</h2><p className="oc-panel-lede">Only you choose who joins Trusted.</p>
      {props.trustedLoading?<div className="oc-empty"><Icon name="loading" size={28}/><strong>Loading Trusted</strong></div>:trustedMembers.length?<div className="oc-person-list">{trustedMembers.map(person=><div className="oc-person-row" key={person.userId}><PersonAvatar person={person}/><span className="oc-person-name">{person.displayName}</span><span className="oc-muted-label">Trusted</span></div>)}</div>:<div className="oc-empty"><span className="oc-empty-icon oc-empty-icon--pink"><Icon name="trusted" size={32}/></span><strong>Keep your closest people here</strong><p>Start with people you already know on One.</p></div>}
      {props.hasMoreTrustedMembers&&!props.trustedLoading?<button className="oc-button oc-button--quiet" disabled={actionBusy} onClick={()=>void invoke(props.onLoadMoreTrustedMembers)}>Load more people</button>:null}
      <button className="oc-button oc-button--primary" type="button" onClick={()=>void invoke(props.onOpenTrusted)} disabled={actionBusy}>Choose trusted people <Icon name="arrow" size={18}/></button>
      {!trustedMembers.length?<button className="oc-text-action" type="button" onClick={()=>open('invite')}>Invite someone instead</button>:null}
    </div>:null}
    {view==='invite'?<div className="oc-sheet-body"><h2 id={sheetHeadingId}>Invite someone</h2><p className="oc-panel-lede">Invite them to One or your Contacts circle.</p>
      <div className="oc-invite-card"><span className="oc-invite-icon oc-invite-icon--blue"><Icon name="invite" size={24}/></span><div><strong>Invite to One</strong><p>Give someone a link to join.</p></div><button className="oc-mini-cta" type="button" onClick={()=>void invoke(props.onInviteToOne)} disabled={actionBusy||!props.inviteReady}>Invite <Icon name="arrow" size={15}/></button></div>
      <div className="oc-invite-card"><span className="oc-invite-icon oc-invite-icon--pink"><Icon name="users" size={24}/></span><div><strong>Invite to Contacts</strong><p>They can join your shared member list.</p></div>{props.canInviteMembers?<button className="oc-mini-cta" type="button" onClick={()=>void invoke(props.onChooseContacts)} disabled={actionBusy||props.circleFull}>Choose <Icon name="arrow" size={15}/></button>:null}</div>
      <div className="oc-code-field"><span>{props.circleCode??'Circle code not ready yet'}</span>{props.circleCode?<button type="button" onClick={()=>void invoke(props.onCopyCircleCode)} disabled={actionBusy||props.circleFull}><Icon name="copy" size={17}/> Copy</button>:<span className="oc-code-wait">Preparing</span>}</div>
      <button className="oc-button oc-button--outline" type="button" disabled={!props.circleCode||!props.onShareCircle||props.circleFull||actionBusy} onClick={()=>void invoke(props.onShareCircle)}>Share circle link <Icon name="share" size={18}/></button>
      {props.canInviteContacts?<button className="oc-text-action" type="button" onClick={()=>void invoke(props.onInviteContacts)} disabled={actionBusy}>Invite contacts</button>:null}
      {props.circleFull?<p className="oc-small-info">Your Contacts circle is full. You can still invite someone to One.</p>:null}
    </div>:null}
    {view==='find'?<div className="oc-sheet-body"><h2 id={sheetHeadingId}>{source==='device'?'Find people from your phone':'Find people with Google Contacts'}</h2><p className="oc-panel-lede">Find people you already know on One.</p>
      <div className="oc-disclosure"><span className="oc-disclosure-icon"><Icon name="users" size={22}/></span><span>Circle members can see who joins.</span></div>
      <div className="oc-disclosure"><span className="oc-disclosure-icon"><Icon name="shield" size={22}/></span><span>Your documents and location are not shared.</span></div>
      <button className="oc-button oc-button--primary" type="button" disabled={actionBusy} onClick={()=>void invoke(props.onFindContacts).then(()=>setView('home'))}>{source==='device'?'Find people':'Continue with Google Contacts'}<Icon name="arrow" size={18}/></button>
      <button className="oc-text-action" type="button" onClick={close}>Not now</button>
    </div>:null}
    {removeTarget?<div className="oc-confirm" role="alertdialog" aria-label="Remove person"><strong>Remove {removeTarget.displayName}?</strong><p>They’ll leave your Contacts circle.</p><div><button type="button" onClick={()=>setRemoveTarget(null)} disabled={confirmBusy}>Cancel</button><button type="button" disabled={confirmBusy} onClick={async()=>{setConfirmBusy(true);try{await props.onRemoveMember?.(removeTarget);setRemoveTarget(null);}catch{announce('Could not remove this person. Try again.');}finally{setConfirmBusy(false);}}}>Remove</button></div></div>:null}
    {notice?<div className="oc-notice" role="status"><Icon name="info" size={17}/>{notice}<button onClick={()=>setNotice('')} aria-label="Dismiss notice" type="button"><Icon name="close" size={15}/></button></div>:null}
   </section></div>:null}
   {notice&&view==='home'?<div className="oc-global-notice" role="status"><Icon name="info" size={17}/>{notice}<button aria-label="Dismiss notice" type="button" onClick={()=>setNotice('')}><Icon name="close" size={15}/></button></div>:null}
 </div>;
}
