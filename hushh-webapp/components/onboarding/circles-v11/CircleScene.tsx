import React from 'react';
import Image from 'next/image';
import {Icon} from './Icons';

/** Original One answering mascot with code-native, scalable graphics. No invented people or profile photos. */
export function CircleScene({src}:{src:string}){
  return <div className="oc-artboard" aria-hidden="true">
    <svg className="oc-backdrop" viewBox="0 0 560 520" fill="none" preserveAspectRatio="xMidYMid meet">
      <rect x="63" y="112" width="260" height="257" rx="92" fill="#F7B5D5"/>
      <path d="M312 84c42-32 99-6 108 37 6 28 28 34 46 26 31-14 54 24 32 46-21 20-14 40 4 51 27 17 13 61-24 55-28-4-37 11-35 34 3 34-42 49-59 22-14-23-35-28-52-11-25 24-61 1-48-28 9-21-2-45-31-49-31-4-36-47-4-58 27-10 36-31 21-56-15-26 18-55 42-39Z" fill="#FFDA70"/>
      <path d="M101 326c22 0 39 16 47 36 4 11 10 15 22 15 23 0 39 18 39 40H99c-36 0-42-40-9-54 14-6 15-19 11-37Z" fill="#BBCDFE"/>
      <path d="m377 373 59-25a8 8 0 0 1 11 5l24 59a8 8 0 0 1-5 11l-58 25a8 8 0 0 1-11-5l-25-59a8 8 0 0 1 5-11Z" fill="#FF7B63"/>
      <path d="M128 158c-56 8-73 52-43 84 31 33 1 61-30 53" stroke="#1D1D1F" strokeWidth="3" strokeLinecap="round" strokeDasharray="4 11" opacity=".42"/>
      <path d="M407 161c49 9 68 36 65 75-2 28-14 42-45 48" stroke="#1D1D1F" strokeWidth="3" strokeLinecap="round" strokeDasharray="4 11" opacity=".36"/>
      <path d="m116 84-5-19m22 19 11-16m4 28 19-3" stroke="#22232B" strokeWidth="3" strokeLinecap="round"/>
      <path d="m468 332 19 4m-5 15 17 11" stroke="#22232B" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="470" cy="127" r="5" fill="#397BF3"/>
      <circle cx="75" cy="355" r="4" fill="#FF7B63"/>
    </svg>
    <div className="oc-art-person oc-art-person--left"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="45" fill="#FFD6A8"/><circle cx="45" cy="34" r="15" fill="#6A4636"/><path d="M15 91v-6c0-20 13-31 30-31s30 11 30 31v6Z" fill="#D37C59"/></svg></div>
    <div className="oc-art-person oc-art-person--right"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="45" fill="#C6E8D8"/><circle cx="45" cy="34" r="15" fill="#4C565D"/><path d="M15 91v-6c0-20 13-31 30-31s30 11 30 31v6Z" fill="#608875"/></svg></div>
    <div className="oc-art-person oc-art-person--top"><svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="45" fill="#E7D8FF"/><circle cx="45" cy="34" r="15" fill="#564C79"/><path d="M15 91v-6c0-20 13-31 30-31s30 11 30 31v6Z" fill="#8975B0"/></svg></div>
    <Image src={src} alt="" className="oc-art-mascot" width={512} height={512} unoptimized draggable={false}/>
    <div className="oc-art-sticker oc-art-sticker--top"><span className="oc-art-sticker-icon"><Icon name="users" size={17}/></span>Stay connected</div>
    <div className="oc-art-sticker oc-art-sticker--bottom"><span className="oc-art-sticker-check"><Icon name="check" size={15} strokeWidth={2.4}/></span>You choose</div>
  </div>;
}
