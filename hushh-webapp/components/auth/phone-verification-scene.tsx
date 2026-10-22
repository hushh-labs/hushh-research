import Image from "next/image";

import styles from "./phone-verification-scene.module.css";

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="6.8" y="2.8" width="10.4" height="18.5" rx="2.4" />
    <path d="M10.5 18.1h3" />
  </svg>
);

const MessageIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5.5h16v11.2H9l-4.3 3.1V16.7H4z" />
    <path d="M8 9.6h8M8 13h5" />
  </svg>
);

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.7l7.2 3v5.9c0 4.7-3.2 8.6-7.2 10-4-1.4-7.2-5.3-7.2-10V5.7z" />
    <path d="m8.7 11.9 2.1 2.1 4.5-4.5" />
  </svg>
);

export function PhoneVerificationScene({ step }: { step: "phone" | "code" }) {
  const code = step === "code";

  return (
    <div className={styles.visual} aria-hidden="true" data-phone-scene={step}>
      <div className={styles.artboard}>
        <svg className={styles.shapes} viewBox="0 0 440 370" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M48 119C47 94 63 74 88 72L205 67C225 66 241 81 241 102L237 228C236 247 218 263 198 263H89C65 263 50 247 49 224L48 119Z" fill="#F7B5D5" />
          <path d="M257 58C272 43 293 46 303 61C320 53 337 60 340 78C360 79 369 95 361 111C375 127 369 145 349 149C346 169 326 176 311 166C293 180 276 171 272 156C253 155 244 139 254 124C242 107 246 91 259 84C254 77 255 68 257 58Z" fill="#FFDE72" />
          <path d="M78 229C89 212 107 211 121 223C137 214 155 220 161 235C183 234 193 250 185 264C200 279 187 294 170 294C162 310 143 312 132 300C109 311 96 303 92 284C71 281 66 260 78 249Z" fill="#B8CFFF" />
          <path d="M310 241c25-14 47-8 55 12l21 51-67 25-25-62c-5-12 3-21 16-26Z" fill="#FF715D" />
          <path d="M71 75 65 61M89 73V57M106 76l7-13M360 185c12-6 21-6 30 0m-27 9c15-1 24 3 29 9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="374" cy="105" r="3.4" fill="#0071E3" />
          <circle cx="76" cy="308" r="3.5" fill="#FF715D" />
        </svg>
        <Image
          src={code ? "/onboarding/mentor-v72/answering-poster.png" : "/onboarding/mentor-v72/connected-poster.png"}
          alt=""
          width={512}
          height={512}
          priority
          className={`${styles.mascot} ${code ? styles.codeMascot : ""}`}
          draggable={false}
        />
        {code ? (
          <>
            <div className={`${styles.sticker} ${styles.topSticker}`}><span className={`${styles.icon} ${styles.blue}`}><MessageIcon /></span>One-time code</div>
            <div className={styles.codeDots}><i /><i /><i /><i /><i /><i /></div>
            <div className={`${styles.sticker} ${styles.bottomSticker}`}><span className={`${styles.icon} ${styles.mint}`}><ShieldIcon /></span>Only for you</div>
          </>
        ) : (
          <>
            <div className={`${styles.sticker} ${styles.topSticker}`}><span className={`${styles.icon} ${styles.blue}`}><PhoneIcon /></span>Your number</div>
            <div className={`${styles.sticker} ${styles.bottomSticker}`}><span className={`${styles.icon} ${styles.pink}`}><MessageIcon /></span>One-time code</div>
          </>
        )}
      </div>
    </div>
  );
}
