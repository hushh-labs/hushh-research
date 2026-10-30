import React from 'react';
import type { IconProps } from './types';
import { PeoplePairIcon } from '@/components/icons';
export function Icon({name,size=20,strokeWidth=1.8,className='',title}:IconProps){
  if(name==='users') return <PeoplePairIcon size={size} className={className} role={title?'img':undefined} aria-label={title} aria-hidden={title?undefined:true}/>;
  const path:Record<string,React.ReactNode>={
    trusted:<><path d="M12 21s-7.5-4.8-9.4-9.2C.9 7.7 3.1 3.4 7.2 3.4c2.1 0 3.6 1.1 4.8 2.7 1.2-1.6 2.7-2.7 4.8-2.7 4.1 0 6.3 4.3 4.6 8.4C19.5 16.2 12 21 12 21Z"/></>,
    invite:<><path d="M16 20v-2.1a4.1 4.1 0 0 0-4.1-4.1H5.1A4.1 4.1 0 0 0 1 17.9V20"/><circle cx="8.5" cy="7" r="3.7"/><path d="M19 7v8M15 11h8"/></>,
    arrow:<><path d="M4 12h16m-6-6 6 6-6 6"/></>,back:<path d="m14.5 5-7 7 7 7"/>,
    check:<path d="m4.5 12 5.2 5 9.8-10"/>,plus:<path d="M12 5v14M5 12h14"/>,
    copy:<><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    share:<><path d="M12 15.5V3.5M7.5 8 12 3.5 16.5 8"/><path d="M6 12.5H4.5A1.5 1.5 0 0 0 3 14v5A1.5 1.5 0 0 0 4.5 20.5h15A1.5 1.5 0 0 0 21 19v-5a1.5 1.5 0 0 0-1.5-1.5H18"/></>,
    link:<><path d="M10 13.5a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.2 1.2"/><path d="M14 10.5a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.2-1.2"/></>,
    close:<path d="M5 5 19 19M19 5 5 19"/>,
    google:<><path stroke="#4285F4" d="M21 12c0-1-.1-1.8-.3-2.5H12V14h5a4.5 4.5 0 0 1-2 2.9"/><path stroke="#34A853" d="M14.9 16.9A6 6 0 0 1 5.9 14"/><path stroke="#FBBC05" d="M5.9 14a6.1 6.1 0 0 1 0-4"/><path stroke="#EA4335" d="M5.9 10A6.1 6.1 0 0 1 16 7l3.1-3A10.6 10.6 0 0 0 12 1.6"/></>,
    phone:<><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M11 17.5h2"/></>,
    shield:<><path d="m12 2 8.4 3.2v6.1c0 5.3-3.5 8.5-8.4 10.7-4.9-2.2-8.4-5.4-8.4-10.7V5.2L12 2Z"/><path d="m8 11.6 2.8 2.7 5.4-5.3"/></>,
    more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
    person:<><circle cx="12" cy="8" r="3.5"/><path d="M4.5 21v-1.5a7.5 7.5 0 0 1 15 0V21"/></>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/></>,
    message:<><path d="M20 12a8 8 0 0 1-8 8c-1.6 0-3-.4-4.2-1.1L3 20l1.1-4.8A8 8 0 1 1 20 12Z"/></>,
    loading:<><path d="M12 2a10 10 0 0 1 10 10"/></>,
  };
  return <svg aria-hidden={title?undefined:true} role={title?'img':undefined} className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{title?<title>{title}</title>:null}{path[name]}</svg>;
}
