#!/usr/bin/env python3
# HUSSH — Mega Map v6 (dual-theme: dark + light), Foundation-palette anchored.
#   ① KEY (jargon decoder)  ② THE PLATFORM (8-layer stack, what/why/how/e.g.)
#   ③ END-TO-END FLOWS (swimlanes; lanes never cross => connections, no spaghetti)
# Adds proper nouns: GCP · Google ADK · A2A · MuleSoft Anypoint · Salesforce FSC ·
#   Apple Mac unified memory / Nvidia RTX Spark on-device · UCP · AP2 agent-economy.
# Colors standardized on the hushh-search-console Foundation palette (ink/gold) but
#   kept CONTRASTIVE for legibility; gold = emphasis/navigation only (Foundation law).
# Renders BOTH hussh-mega-map.dark.svg and hussh-mega-map.light.svg.
import html, math, re
def e(s): return html.escape(str(s))

W=3320; AX0=100; INW=W-2*AX0

# ---------------- THEME SYSTEM (Foundation palette, dark + light) ----------------
THEMES = {
 "dark": {
   "bg":"#0a0a0c","panel":"#15151c","card":"#17171f","layerframe":"rgba(255,255,255,0.018)",
   "ink":"#f5f5f7","sub":"#d6d6df","faint":"#a0a0ad","hair":"#2a2a36",
   "gold":"#d4a574","gold_deep":"#e8c9a0",
   "status":{"ship":("#34d399","rgba(6,78,59,0.30)"),"appr":("#fbbf24","rgba(120,53,15,0.26)"),"fut":("#fb7185","rgba(136,19,55,0.24)")},
   "tag":{"EXP":"#22d3ee","CHAN":"#38bdf8","PAY":"#d4a574","AGENT":"#34d399","MEM":"#a78bfa","TRUST":"#fb7185","INGEST":"#fbbf24","INFRA":"#9ca3af","EXT":"#f0abfc"},
   "why":"#fbbf24","how":"#7dd3fc","eg":"#9fe7c4",
   "cardline":"#2c2c3a","lanebg":"rgba(255,255,255,0.022)","laneborder":"#27273400",
   "glossborder":"#26263200","glosskey":"#d4a574","stepoverlay":"rgba(255,255,255,0.02)",
   "gtagbg":"rgba(212,165,116,0.12)","gtagborder":"rgba(212,165,116,0.40)","gtagink":"#e8c9a0",
   "badge_ink":"#0a0a0c","grid":"#0d0d11","frame":"#23232e",
 },
 "light": {
   "bg":"#f5f5f7","panel":"#ffffff","card":"#ffffff","layerframe":"rgba(0,0,0,0.012)",
   "ink":"#1d1d1f","sub":"#48484d","faint":"#6e6e73","hair":"#e5e5ea",
   "gold":"#7a5722","gold_deep":"#5f4318",
   "status":{"ship":("#047857","rgba(5,150,105,0.10)"),"appr":("#5f4318","rgba(184,137,77,0.18)"),"fut":("#c81e1e","rgba(220,38,38,0.07)")},
   "tag":{"EXP":"#0e7490","CHAN":"#0369a1","PAY":"#8a6530","AGENT":"#047857","MEM":"#6d28d9","TRUST":"#be123c","INGEST":"#b45309","INFRA":"#52525b","EXT":"#a21caf"},
   "why":"#b45309","how":"#0369a1","eg":"#047857",
   "cardline":"#e5e5ea","lanebg":"rgba(0,0,0,0.018)","laneborder":"#e5e5ea",
   "glossborder":"#e5e5ea","glosskey":"#8a6530","stepoverlay":"rgba(0,0,0,0.01)",
   "gtagbg":"rgba(122,87,34,0.08)","gtagborder":"rgba(122,87,34,0.35)","gtagink":"#6f4f22",
   "badge_ink":"#ffffff","grid":"#ececef","frame":"#dcdce0",
 },
}

# ---------------- PLATFORM (static): layer -> components ----------------
# card tuple = (name, GENERIC category, what, why, how, e.g., status, stories)
# name = the proper noun / product · GENERIC = the vendor-neutral role it plays
LAYERS_ALL=[
 ("EXPERIENCE · INTERACTION","EXP","where a person or an AI meets Hussh — web, native, on-device, external hosts",[
   ("Web · Next.js","web app","browser app on shared React shell","reach anyone, zero install","web-proxy transport → /api","app.hushh.ai","ship",[1]),
   ("iOS / Android · Capacitor","native mobile app","native shell, secure enclave","Face ID + push","native-plugin transport","biometric unlock","ship",[8]),
   ("Apple Mac / Nvidia RTX Spark","on-device compute","unified-memory local machine","private local compute, dev power","runs Hermes runtime · MLX","\"set up my GCP\"","fut",[9]),
   ("Claude · Cursor · ChatGPT","external AI host","3rd-party AI clients","meet users where they work","MCP consent tools","Claude reads scoped data","ship",[7]),
 ]),
 ("CHANNELS · ECOSYSTEM","CHAN","governed ways results & capabilities reach users, devs, partners",[
   ("Developer API · /api/v1","REST API","REST consent surface","integrate from any stack","discover→consent→export","curl the flow","ship",[5,7]),
   ("@hushh/mcp · Hosted MCP","tool-call bridge","managed MCP server","plug AI tools in instantly","6 consent tools","Claude asks for data","ship",[5,7]),
   ("A2A","agent-to-agent transport","Agent2Agent protocol","agents call agents safely","A2A over scoped consent","One → partner agent","appr",[5]),
   ("Marketplace","exchange","RIA ↔ investor exchange","share strategies safely","relationship-share grant","adviser shares picks","appr",[10]),
   ("Certification","trust tiers","agent trust tiers","users trust what they install","Sandbox→Verified→Trusted","\"verified\" badge","appr",[5]),
 ]),
 ("COMMERCE · PAYMENTS · AGENT ECONOMY","PAY","the value-inversion layer — brands' agents bid; money flows to the user",[
   ("UCP","commerce protocol","Universal Commerce Protocol","join the agent-commerce rails","REST/JSON-RPC · business stays MoR","catalog→cart→checkout","fut",[11]),
   ("AP2","payment-auth protocol","Agent Payments Protocol (FIDO)","prove intent-to-pay; settle money","Intent→Cart→Payment mandate · SCA","agent pays safely","fut",[11,12]),
   ("Demand Agent","advertiser agent","brand's buyer-of-attention agent","reach users via their agent","request_consent(scope, BID)","brand bids $12","fut",[12]),
   ("Reverse-Auction Bid","priced consent","value flows to the user","flip the ad economy","PCHP bid + AP2 settle · Nav reserve","user gets PAID","fut",[12]),
   ("Salesforce FSC + MuleSoft Anypoint","enterprise CRM + iPaaS","partner system sync, user-owned","keep CRM current, no mirror","iPaaS proxy · narrow fields","CRM record update","fut",[6]),
 ]),
 ("INTELLIGENCE · AGENTS","AGENT","reason, debate, delegate & act inside scoped authority — never raw keys",[
   ("Hermes (Nous)","agent runtime","the runtime One runs on","one runtime, many surfaces","streaming loop + tools + MCP","powers One / Kai / Nav","appr",[1,9]),
   ("Agent ONE","orchestrator agent","the top personal agent","one mind that coordinates","Listen·Remember·Decide·Act","routes to specialists","appr",[1]),
   ("Nav","guardian agent","privacy / consent guardian","enforce scope, reserve, deletion","validates every request + bid","blocks over-broad asks","appr",[7,12]),
   ("Kai · Google ADK","finance specialist","shipped finance agent","real investing help","ADK runtime + tools","analyze one stock","ship",[4]),
   ("AlphaAgents → broker","execution engine","debate → DecisionCard → trade","reasoned calls, not hype","3-agent debate + Renaissance","Buy/Hold/Reduce","appr",[4]),
   ("Hussh SDK","agent dev kit","build-your-own agent","everyone extends Hussh","know · do · remember + MCP","ship a custom agent","appr",[5]),
 ]),
 ("DATA · KNOWLEDGE · PKM","MEM","the heart: one encrypted store the user truly owns (zero-knowledge)",[
   ("pkm_blobs","encrypted store","encrypted domain data","this IS the memory","ciphertext·iv·tag per domain","server can't read it","ship",[1]),
   ("manifests + scope registry","metadata index","structure & visibility","know what exists & who sees","revisions + posture","field-level scopes","ship",[1]),
   ("24-domain schema","data ontology","life in 6 families","shared meaning for agents","Being·Knowing·Relating·Having·Wanting·Acting","finance·health·brands","appr",[1,2]),
   ("pkm_index","discovery view","safe discovery projection","find without exposing","projection, no plaintext","\"has finance: yes\"","ship",[1]),
   ("market & provider caches","derived cache","freshness-aware derived data","fast, degraded-state aware","accounts · email · market state","portfolio refresh","ship",[3,6]),
 ]),
 ("TRUST · IDENTITY · CONSENT · PCHP","TRUST","every action proves identity & earns consent first — the gate",[
   ("Firebase Auth","identity provider","bootstrap who is acting","anchor the actor","ID token (1h)","Sign in with Apple","ship",[1,8]),
   ("Vault Unlock · BYOK","key custody","biometric key unlock","only you hold the key","PBKDF2 100k, key in memory","Face / Touch ID","ship",[1,7]),
   ("Capability Tokens","access tokens","scoped, least-privilege","limit blast radius","VAULT_OWNER 24h · scoped 7d","HCT:… signed","ship",[7]),
   ("PCHP","consent protocol","6-phase consent handshake","revocable, purpose-bound","Discover→Hello→Offer→Consent→Deliver→Ack","brand asks \"receipts\"","appr",[7]),
   ("ZK Scoped Export + audit","encrypted release","encrypted field release","server never sees plaintext","AES-GCM + X25519 wrap; CRT/DAT","share only \"food prefs\"","ship",[7]),
 ]),
 ("CORE PLATFORM SERVICES","INGEST","the backend that enforces policy & brings chosen data in",[
   ("Consent Protocol routes","policy API","FastAPI policy surface","clients can't improvise","consent·PKM·IAM·Kai·RIA","/api/* contracts","ship",[7]),
   ("AI-Memory Import","import connector","import past AI chats","bootstrap PKM fast","OAuth → parse → domains","ChatGPT / Claude export","fut",[2]),
   ("Gmail Connector","email connector","receipts & brand signals","understand real spending","scoped read (receipts)","1yr receipts → brands","ship",[3,5]),
   ("Plaid Connector","accounts aggregator","financial-accounts link","advise on real holdings","read-only account link","balances → portfolio","ship",[3,6]),
   ("RIA Intelligence API","OSINT engine","public-profile dossier engine","claim who you are online","verify→dossier→image rank","verify adviser","appr",[3,10]),
 ]),
 ("INFRASTRUCTURE","INFRA","the governed foundation everything above runs on",[
   ("GCP · Cloud Run + Vertex","cloud compute + LLM","serverless compute + Gemini","scales · governed deploys","UAT → prod parity","hosts API + MCP","ship",[]),
   ("Supabase / Postgres","database","relational data plane","durable workflow state","consent·audit·metadata","ciphertext rows","ship",[]),
   ("GCP Secret Manager","secret store","secret store","no keys in code","runtime refs · BYOK refs","model API keys","ship",[]),
   ("Firebase / FCM","auth + push","auth + push messaging","identity & notifications","tokens + messaging","consent push prompt","ship",[]),
   ("CI/CD","delivery pipeline","delivery pipeline","safe, repeatable ships","parity gates UAT→prod","blocked on red test","ship",[]),
 ]),
]
# handoff caption between a layer and the next, keyed by the FROM-layer tag.
HANDOFF={
 "EXP":"the surfaces reach people through governed channels …",
 "CHAN":"channels open the agent-economy where brands transact …",   # full (CHAN→PAY)
 "PAY":"every transaction is driven by agents that …",
 "AGENT":"act on scoped memory provided by …",
 "MEM":"the encrypted PKM, whose every read/write is gated by …",
 "TRUST":"the trust & consent layer, enforced through …",
 "INGEST":"core platform services, all running on the infrastructure foundation.",
}
HANDOFF_PUBLIC_CHAN="channels distribute the same governed truth to the agents that …"  # CHAN→AGENT when PAY dropped

# ---------------- FLOWS (swimlanes): num,title,status,[(layerTag, step text), ...] ----------------
FLOWS_ALL=[
 ("1","Build PKM","ship",[("EXP","Sign in — Apple / Google"),("TRUST","Mint VAULT_OWNER · 24h"),
   ("TRUST","Unlock vault · BYOK biometric"),("MEM","Client encrypts domain"),
   ("INGEST","POST /api/pkm/store-domain"),("MEM","pkm_blobs ciphertext + index")]),
 ("2","Import ChatGPT / Claude","fut",[("EXT","OAuth the AI provider"),("INGEST","Download memory export"),
   ("INGEST","Parse → map to 24 domains"),("MEM","Client encrypts"),("MEM","store-domain → mind·prefs")]),
 ("3","Claim public profile","appr",[("INGEST","Seed: name·email·phone"),("INGEST","Stage 1 · Gemini verify (FINRA/SEC)"),
   ("INGEST","Phase 2 · dossier (web OSINT)"),("INGEST","Image discover + rank"),
   ("EXP","User selectively claims"),("MEM","store-domain")]),
 ("4","AlphaAgents → trade","appr",[("EXP","Ask Kai · /api/kai/analyze"),("AGENT","3-agent debate · Fund·Sent·Val"),
   ("AGENT","Renaissance overlay tiers"),("AGENT","DecisionCard · Buy/Hold/Reduce"),
   ("MEM","store decision · financial"),("PAY","(future) broker order")]),
 ("5","Build Hussh agents","appr",[("CHAN","SDK · know·do·remember"),("CHAN","Register + certify (tiers)"),
   ("CHAN","Publish to marketplace"),("AGENT","Runs under One / Nav contract"),("CHAN","Requests data via /api/v1")]),
 ("6","CRM via FSC + MuleSoft","fut",[("EXT","Salesforce FSC request"),("TRUST","Consent · narrow fields only"),
   ("PAY","MuleSoft Anypoint proxy"),("EXT","FSC updated — never a PKM mirror"),("TRUST","consent receipt logged")]),
 ("7","Consent via MCP · PCHP","ship",[("EXT","RS Discovery · .well-known/hussh"),("EXT","Hello — UA capabilities"),
   ("EXT","Offer — scopes · purpose · TTL"),("TRUST","Consent · biometric → CRT"),
   ("TRUST","ZK export · AES-GCM + X25519"),("TRUST","Ack → audit / transparency log")]),
 ("8","Native + Web parity","ship",[("EXP","User triggers an action"),("EXP","Generated action plane"),
   ("EXP","web proxy / native Capacitor"),("INGEST","Consent Protocol API"),("EXP","same truth, any surface")]),
 ("9","On-device edge","fut",[("EXP","Mac · Hermes runtime"),("EXP","Apple unified mem / RTX Spark"),
   ("AGENT","MLX on-device inference"),("AGENT","Dev tools · GCP·GitHub·CLI·MCP"),("TRUST","Acts under same consent")]),
 ("10","RIA shares strategies","appr",[("AGENT","Advisor builds picks"),("CHAN","Marketplace · relationship grant"),
   ("CHAN","ria_active_picks_feed_v1"),("EXP","Chosen investor contacts"),("EXP","Investor market home")]),
 ("11","Agentic commerce · UCP + AP2","fut",[("EXP","User asks agent to buy"),("AGENT","One forms Intent Mandate"),
   ("PAY","UCP catalog → cart"),("TRUST","Consent + biometric"),("PAY","AP2 Payment Mandate · SCA"),("PAY","Merchant settles — stays MoR")]),
 ("12","Consent reverse-auction","fut",[("EXT","Demand Agent · discover_user_domains"),("EXT","request_consent(scope, BID, offer)"),
   ("TRUST","Nav clears reserve price"),("TRUST","CRT = consent + PAID receipt"),("PAY","AP2 settles bid → user wallet"),("MEM","DAT releases scoped field")]),
]

GLOSS_ALL=[("Hussh","Human Secure Socket Host"),("PKM","Personal Knowledge Model — your encrypted memory"),
("PCHP","Personal Consent Handshake Protocol (6-phase)"),("BYOK","Bring Your Own Key — only you hold it"),
("ZK","Zero-Knowledge — server sees ciphertext only"),("VAULT_OWNER","master consent token (24h)"),
("CRT / DAT","consent receipt + data-access token"),("HCT","Hussh Consent Token format"),
("MCP","Model Context Protocol — the AI tool bridge"),("ADK","Agent Development Kit (Google)"),
("A2A","Agent-to-Agent delegation protocol"),("MLX","Apple-silicon on-device ML"),
("Hermes","on-device agent runtime (Nous)"),("AlphaAgents","Kai's 3-agent investment debate"),
("DecisionCard","Buy / Hold / Reduce verdict"),("One·Kai·Nav","orchestrator · finance · privacy"),
("RIA","Registered Investment Adviser"),("OSINT","open-web intelligence"),
("FINRA / SEC","US securities regulators"),("Plaid","read-only account aggregator"),
("UCP","Universal Commerce Protocol (catalog→checkout)"),("AP2","Agent Payments Protocol (FIDO mandates)"),
("Intent / Cart / Payment","AP2's 3-step mandate chain"),("VDC","Verifiable Digital Credential"),
("SCA","Strong Customer Authentication (dynamic-link)"),("MoR","Merchant of Record — business keeps it"),
("Demand Agent","brand/advertiser's agent (buyer of attention)"),("Reverse-Auction Bid","priced consent — value to the user"),
("Salesforce FSC","Financial Services Cloud"),("MuleSoft Anypoint","enterprise integration / VPC proxy"),
("GCP · Vertex","Google Cloud + Gemini models"),("RTX Spark","Nvidia on-device compute"),
("Apple unified memory","Mac on-device shared-memory compute"),("X25519-AES-GCM","scoped-export encryption"),
("FCM","Firebase Cloud Messaging push"),("Tri-flow","web / native / MCP parity")]


# vendor/proper-noun → generic, for the PUBLIC variant (longest-match first)
SANITIZE=[
 ("Salesforce FSC + MuleSoft Anypoint","Enterprise CRM + iPaaS"),("Salesforce FSC","Enterprise CRM"),
 ("MuleSoft Anypoint · narrow fields","iPaaS · narrow fields"),("MuleSoft Anypoint proxy","iPaaS proxy"),("MuleSoft Anypoint","iPaaS"),("MuleSoft","iPaaS"),("FSC + MuleSoft","CRM + iPaaS"),("FSC","CRM"),
 ("iPaaS proxy · narrow","iPaaS · narrow"),("iPaaS proxy proxy","iPaaS proxy"),
 ("GCP · Cloud Run + Vertex","Cloud compute + LLM"),("GCP · Vertex","Cloud + LLM"),("GCP Secret Manager","Secret store"),
 ("GCP·GitHub·CLI·MCP","cloud·source·CLI·MCP"),("GCP","cloud"),("Vertex","managed LLM"),("Gemini verify (FINRA/SEC)","verify (regulators)"),("Gemini","model"),
 ("Apple Mac / Nvidia RTX Spark","On-device compute"),("Nvidia RTX Spark","on-device GPU"),("RTX Spark","on-device GPU"),
 ("Apple unified memory","on-device shared memory"),("Apple unified mem","on-device memory"),("Apple Mac","on-device machine"),
 ("Kai · Google ADK","Kai · finance runtime"),("Kai · Google","Kai"),
 ("Apple-silicon on-device ML","on-device ML"),("the device platform silicon","on-device silicon"),("Apple-silicon","on-device silicon"),
 ("Sign in — Apple / Google","Sign in — identity provider"),("Sign in with Apple","Sign in — identity provider"),
 ("Face / Touch ID","device biometric"),("Face ID","device biometric"),("Touch ID","device biometric"),("Apple","the device platform"),("Google ADK","agent dev kit"),("Google","the cloud provider"),
 ("Claude · Cursor · ChatGPT","External AI hosts"),("ChatGPT / Claude","an AI provider"),("Claude · Cursor","external AI clients"),
 ("Claude reads scoped data","AI host reads scoped data"),("Claude asks for data","an AI host asks for data"),("Claude","an AI host"),("Cursor","AI client"),("ChatGPT","an AI provider"),("Import ChatGPT / Claude","Import an AI provider"),
 ("Plaid Connector","Accounts connector"),("Plaid Link","account link"),("Plaid","accounts aggregator"),
 ("Gmail Connector","Email connector"),("Gmail","email"),
 ("Google ADK","agent dev kit"),("ADK runtime + tools","agent runtime + tools"),("Agent Development Kit (Google)","agent dev kit"),("agent dev kit (Google)","agent dev kit"),("ADK","agent dev kit"),
 ("Hermes (Nous)","Agent runtime"),("Mac · Hermes runtime","On-device · agent runtime"),("Hermes runtime","agent runtime"),("Hermes","agent runtime"),("(Nous)",""),("Nous Research","research lab"),("Nous",""),
 ("Firebase Auth","Identity provider"),("Firebase / FCM","Auth + push"),("Firebase Cloud Messaging push","push messaging"),("Firebase identity","identity provider"),("Firebase","auth"),("FCM","push messaging"),
 ("Supabase / Postgres","Database"),("Supabase","Postgres"),
 ("@hushh/mcp · Hosted MCP","Hosted MCP server"),("@hushh/mcp","hosted MCP"),
 ("Next.js","web framework"),("Capacitor","native shell"),("MLX","on-device ML"),
 ("Renaissance overlay tiers","systematic overlay tiers"),("Renaissance","systematic"),
 ("FINRA/SEC","regulators"),("FINRA / SEC","regulators"),("FINRA","regulator"),("SEC","regulator"),
 ("hushh-research/docs","platform docs"),("hussh-dev-platform","the SDK spec"),("hushh-ria-intelligence-api","the research engine"),
]
def sanitize(s,public):
    if not public: return s
    for a,b in SANITIZE: s=s.replace(a,b)
    return s


def render(theme_name, public=False):
    TH=THEMES[theme_name]
    BG=TH["bg"];PANEL=TH["panel"];CARD=TH["card"];INK=TH["ink"];SUB=TH["sub"];FAINT=TH["faint"]
    GOLD=TH["gold"];GOLDD=TH["gold_deep"];HAIR=TH["hair"];ST=TH["status"];TAGC=TH["tag"]
    # PUBLIC variant: drop the commerce/payments layer + the two commerce flows, filter glossary
    if public:
        LAYERS=[L for L in LAYERS_ALL if L[1]!="PAY"]
        FLOWS=[f for f in FLOWS_ALL if f[0] not in ("11","12")]
        DROP_GLOSS={"UCP","AP2","Intent / Cart / Payment","VDC","SCA","MoR","Demand Agent","Reverse-Auction Bid","Salesforce FSC","MuleSoft Anypoint","GCP · Vertex","RTX Spark","Apple unified memory","Plaid","FINRA / SEC"}
        GLOSS=[g for g in GLOSS_ALL if g[0] not in DROP_GLOSS]
    else:
        LAYERS=LAYERS_ALL; FLOWS=FLOWS_ALL; GLOSS=GLOSS_ALL
    S=[]
    def T(x,y,s,sz=14,fill=INK,a="start",w="400",ls="0",op=1.0):
        S.append(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{sz}" fill="{fill}" text-anchor="{a}" font-weight="{w}" letter-spacing="{ls}" opacity="{op}">{e(sanitize(s,public))}</text>')
    def box(x,y,w,h,rx,fill,stroke,sw=1.5,dash=None,op=1.0):
        d=f' stroke-dasharray="{dash}"' if dash else ''
        st=f' stroke="{stroke}" stroke-width="{sw}"' if stroke else ''
        S.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill}"{st}{d} opacity="{op}"/>')
    def wrap(text,mc):
        out=[];line=""
        for wd in str(text).split():
            if len(line)+len(wd)+1>mc: out.append(line);line=wd
            else: line=(line+" "+wd).strip()
        if line: out.append(line)
        return out
    # colorblind-safe REDUNDANT shape glyph per status (works without hue):
    #   ship = filled disc ● · appr = filled diamond ◆ · fut = hollow ring ○
    def glyph(cx,cy,status,col,r=5.0):
        if status=="ship":
            S.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{col}"/>')
        elif status=="appr":
            S.append(f'<path d="M{cx:.1f},{cy-r-0.5:.1f} L{cx+r+0.5:.1f},{cy:.1f} L{cx:.1f},{cy+r+0.5:.1f} L{cx-r-0.5:.1f},{cy:.1f} Z" fill="{col}"/>')
        else:  # fut = hollow ring
            S.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="none" stroke="{col}" stroke-width="2.0"/>')

    # geometry pre-pass
    sx0=AX0; stackw=INW
    HEADER=210
    KEY_HEAD=58; JR_CH=80; gc=5
    KEY_ROWS=math.ceil(len(GLOSS)/gc); KEY_H=KEY_HEAD+KEY_ROWS*JR_CH+30
    def card_h(chips,cwid):
        mc=int((cwid-78)/6.2); m=0
        for c in chips:
            h=94  # name + generic-tag row + what + divider
            for _,key in (("WHY",3),("HOW",4),("e.g.",5)):
                if c[key]: h+=len(wrap(c[key],mc))*16+6
            m=max(m,h+12)
        return m
    laymeta=[]
    for (lname,tag,ltag,chips) in LAYERS:
        k=len(chips); cwid=(stackw-(k-1)*20)/k
        laymeta.append((cwid,card_h(chips,cwid)))
    LAY_TITLE=54; CONN_H=66; PLAT_HEAD=100
    plat_body=sum(LAY_TITLE+laymeta[i][1]+(CONN_H if i<len(LAYERS)-1 else 0) for i in range(len(LAYERS)))
    PLAT_H=PLAT_HEAD+plat_body+24
    FL_HEAD=92; LH=120; LGAP=16
    FLOWS_H=FL_HEAD+len(FLOWS)*(LH+LGAP)+30
    H=HEADER+KEY_H+PLAT_H+FLOWS_H+110

    PAD=120; CW=W+2*PAD; CH=int(H)+2*PAD
    S.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" '
             f'preserveAspectRatio="xMidYMid meet" style="max-width:100%;height:auto;display:block;background:{BG}" '
             f'font-family="\'Inter\',\'Helvetica Neue\',Arial,sans-serif">')
    # Unique per-render def IDs so multiple SVGs inlined on the same HTML page
    # (e.g. light + dark on the wiki) never share <pattern>/<gradient> IDs. SVG
    # url(#id) resolves to the FIRST match in the document — without this the dark
    # map would pull the light map's grid pattern (visible gridlines bug).
    uid = f"{theme_name}{'_pub' if public else ''}"
    S.append('<defs>'
     f'<linearGradient id="tt_{uid}" x1="0" x2="1"><stop offset="0" stop-color="{GOLD}"/><stop offset="1" stop-color="{GOLDD}"/></linearGradient>'
     f'<pattern id="grid_{uid}" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="{TH["grid"]}" stroke-width="1"/></pattern>'
     '</defs>')
    S.append(f'<rect width="{CW}" height="{CH}" fill="{BG}"/>')
    S.append(f'<rect width="{CW}" height="{CH}" fill="url(#grid_{uid})"/>')
    S.append(f'<g transform="translate({PAD},{PAD})">')
    # outer frame
    box(-40,-30,W+80,int(H)+60,28,"none",TH["frame"],1.4)

    # ============ TITLE ============
    S.append(f'<circle cx="{AX0+10}" cy="58" r="11" fill="{ST["ship"][0]}"><animate attributeName="opacity" values="1;.3;1" dur="2.4s" repeatCount="indefinite"/></circle>')
    T(AX0+38,70,"Hussh",54,f"url(#tt_{uid})","start","800")
    T(AX0+232,70,"The Whole Map",40,INK,"start","300","0.3")
    T(W-AX0,70,".",54,GOLD,"end","800")  # gold terminal period (Foundation signature)
    T(AX0+40,110,"Human Secure Socket Host — Consent-Driven Personal Intelligence.   Your data. Your agents. Yours to own.",20,SUB)
    T(AX0+40,140,f"Read down: ① decode the words · ② the platform (what it is) · ③ end-to-end flows (how every story connects).    [{theme_name.upper()} MODE]",15,FAINT)
    T(W-AX0,108,"AS OF  June 11, 2026",17,ST["ship"][0],"end","700","0.5")
    lx=W-AX0-760; ly=132
    for i,(lab,key) in enumerate([("SHIPPED — live","ship"),("APPROVED — direction","appr"),("FUTURE — planned","fut")]):
        c,f=ST[key]; cxp=lx+i*262; box(cxp,ly-17,28,23,6,f,c,2.4); glyph(cxp+14,ly-5.5,key,c,5.0); T(cxp+38,ly,lab,15.5,INK,"start","600")
    T(W-AX0,158,"shape = status (colorblind-safe):  ● shipped   ◆ approved   ○ future",13,FAINT,"end","500")
    y=HEADER

    # ============ ① KEY ============
    T(AX0,y+36,"①  KEY",30,INK,"start","800","0.3")
    T(AX0+150,y+36,"— every acronym in plain English (decode FIRST, then read the map)",19,SUB,"start","400")
    gcw=(INW-(gc-1)*30)/gc; gy0=y+KEY_HEAD+22
    for i,(t,defn) in enumerate(GLOSS):
        c=i%gc; r=i//gc; gx=AX0+c*(gcw+30); gyy=gy0+r*JR_CH
        box(gx,gyy,gcw,JR_CH-18,9,PANEL,TH["glossborder"],1.2 if TH["glossborder"]!="#26263200" else 0)
        T(gx+16,gyy+27,t,16,TH["glosskey"],"start","700")
        for j,ln in enumerate(wrap(defn,int((gcw-30)/6.4))[:2]): T(gx+16,gyy+48+j*16,ln,12,SUB)
    y+=KEY_H

    # ============ ② PLATFORM ============
    T(AX0,y+40,"②  THE PLATFORM",30,INK,"start","800","0.3")
    T(AX0+300,y+40,f"— what it is. {('Seven' if public else 'Eight')} layers; each card shows the name, its generic role (tag), then what · why · how · e.g.  Read top → down.",18,SUB,"start","400")
    cy=y+PLAT_HEAD
    for li,(lname,tag,ltag,chips) in enumerate(LAYERS):
        lcol=TAGC[tag]; cwid,ch=laymeta[li]
        T(sx0,cy+30,lname,23,lcol,"start","800","0.4")
        T(sx0+len(lname)*15+30,cy+30,"— "+ltag,15,SUB,"start","400")
        by=cy+LAY_TITLE
        box(sx0-14,by-10,stackw+28,ch+20,16,TH["layerframe"],lcol,1.6,dash="1,9")
        for ci,c in enumerate(chips):
            x=sx0+ci*(cwid+20); cyy=by; col,fill=ST[c[6]]
            box(x,cyy,cwid,ch,12,CARD,None,0); box(x,cyy,cwid,ch,12,fill,col,1.6)
            glyph(x+16,cyy+20,c[6],col,4.6)
            T(x+30,cyy+25,c[0],15.5,INK,"start","700")
            if c[7]:
                bx=x+cwid-12
                for stn in reversed(c[7]):
                    bw=22+(6 if stn>=10 else 0); bx-=bw
                    box(bx,cyy+10,bw,20,10,col,None,0); T(bx+bw/2,cyy+24,str(stn),12,TH["badge_ink"],"middle","700"); bx-=6
            # generic category tag pill (the vendor-neutral role)
            gtxt=c[1]; gw=len(gtxt)*6.2+18
            box(x+16,cyy+34,gw,17,8,TH["gtagbg"],TH["gtagborder"],1.0)
            T(x+16+gw/2,cyy+46,gtxt,10.5,TH["gtagink"],"middle","700","0.3")
            # what (plain definition)
            T(x+16,cyy+66,c[2],12.5,SUB,"start","500")
            S.append(f'<line x1="{x+16}" y1="{cyy+76}" x2="{x+cwid-16}" y2="{cyy+76}" stroke="{TH["cardline"]}" stroke-width="1"/>')
            mc=int((cwid-78)/6.2); fy=cyy+96
            for lab,key,lc in (("WHY",3,TH["why"]),("HOW",4,TH["how"]),("e.g.",5,TH["eg"])):
                if not c[key]: continue
                ls=wrap(c[key],mc); T(x+16,fy,lab,10.5,lc,"start","800","0.5")
                for j,ln in enumerate(ls): T(x+62,fy+j*16,ln,11.8,SUB)
                fy+=len(ls)*16+6
        cy=by+ch
        if li<len(LAYERS)-1:
            midx=AX0+INW/2
            gcY=cy+(CONN_H+LAY_TITLE)/2
            cap=HANDOFF_PUBLIC_CHAN if (public and tag=="CHAN") else HANDOFF[tag]; capW=len(sanitize(cap,public))*7.4
            chevW=24; gapx=16; total=chevW+gapx+capW; left=midx-total/2; ccx=left+chevW/2
            S.append(f'<path d="M{ccx-12:.0f},{gcY-7:.0f} L{ccx:.0f},{gcY+7:.0f} L{ccx+12:.0f},{gcY-7:.0f}" fill="none" stroke="{lcol}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>')
            T(left+chevW+gapx,gcY+5,cap,14.5,SUB,"start","500")
            cy+=CONN_H
    y+=PLAT_H

    # ============ ③ END-TO-END FLOWS ============
    T(AX0,y+40,"③  END-TO-END FLOWS",30,INK,"start","800","0.3")
    T(AX0+440,y+40,"— how it connects. Each story is ONE left → right sequence of real steps. Lanes never cross.",18,SUB,"start","400")
    tl=[("EXP","Experience"),("CHAN","Channels"),("PAY","Commerce/Pay"),("AGENT","Agents"),("MEM","Memory"),("TRUST","Trust"),("INGEST","Services"),("EXT","External")]
    txp=AX0
    for tg,lab in tl:
        box(txp,y+58,16,16,4,TAGC[tg],None,0); T(txp+22,y+71,lab,12.5,SUB,"start","500"); txp+=len(lab)*7.0+54
    LAB_W=300; steps_x=AX0+LAB_W+24; steps_w=INW-LAB_W-24
    ly0=y+FL_HEAD
    for fi,(num,title,stt,stps) in enumerate(FLOWS):
        ly=ly0+fi*(LH+LGAP); col,fill=ST[stt]
        box(AX0,ly,INW,LH,14,TH["lanebg"],TH["laneborder"],1.2 if TH["laneborder"]!="#27273400" else 0)
        mid=ly+LH/2
        # status-shaped badge (colorblind-redundant): ship=disc, appr=diamond, fut=ring
        if stt=="ship":
            S.append(f'<circle cx="{AX0+36}" cy="{mid}" r="22" fill="{col}"/>'); T(AX0+36,mid+7,num,20,TH["badge_ink"],"middle","800")
        elif stt=="appr":
            S.append(f'<path d="M{AX0+36},{mid-26} L{AX0+62},{mid} L{AX0+36},{mid+26} L{AX0+10},{mid} Z" fill="{col}"/>'); T(AX0+36,mid+7,num,19,TH["badge_ink"],"middle","800")
        else:
            S.append(f'<circle cx="{AX0+36}" cy="{mid}" r="21" fill="{TH["card"]}" stroke="{col}" stroke-width="3.2"/>'); T(AX0+36,mid+7,num,20,col,"middle","800")
        tlw=wrap(title,19)[:2]; n_t=len(tlw)
        ty=mid-(n_t*22-9)/2
        for ln in tlw: T(AX0+72,ty,ln,17,INK,"start","700"); ty+=22
        T(AX0+72,ty,{"ship":"SHIPPED","appr":"APPROVED","fut":"FUTURE"}[stt],12,col,"start","700","1")
        n=len(stps); gap=40; cw=(steps_w-(n-1)*gap)/n; chh=LH-28
        for si,(tg,txt) in enumerate(stps):
            x=steps_x+si*(cw+gap); cyy=ly+14; tc=TAGC[tg]
            box(x,cyy,cw,chh,10,CARD,None,0); box(x,cyy,cw,chh,10,TH["stepoverlay"],tc,1.4)
            box(x,cyy,7,chh,10,tc,None,0)
            tlines=wrap(txt,int((cw-30)/6.6))[:3]
            blk=20+len(tlines)*16; ty0=cyy+chh/2-blk/2+16
            T(x+18,ty0,tg,11,tc,"start","800","0.8")
            for j,ln in enumerate(tlines): T(x+18,ty0+20+j*16,ln,12.5,INK,"start","500")
            if si<n-1:
                ax=x+cw; ay=cyy+chh/2
                S.append(f'<line x1="{ax+8:.0f}" y1="{ay:.0f}" x2="{ax+gap-12:.0f}" y2="{ay:.0f}" stroke="{col}" stroke-width="2.4" opacity="0.85"/>')
                S.append(f'<path d="M{ax+gap-12:.0f},{ay-6:.0f} L{ax+gap-2:.0f},{ay:.0f} L{ax+gap-12:.0f},{ay+6:.0f}" fill="{col}"/>')
    y+=FLOWS_H

    if public:
        T(AX0,y+12,"Greenfield (future): AI-memory import · public-profile→PKM · broker execution · partner-system sync · on-device edge.",15,ST["fut"][0],"start","600")
        T(AX0,y+40,"Grounded in the canonical Hussh platform docs, the SDK protocol spec, and the research engine. Status is honest, not aspirational.",13.5,FAINT)
    else:
        T(AX0,y+12,"Greenfield (future): ② AI-memory import · ③ public-profile→PKM · ④ broker execution · ⑥ FSC/MuleSoft · ⑨ on-device edge · ⑪ UCP+AP2 commerce · ⑫ consent reverse-auction.",15,ST["fut"][0],"start","600")
        T(AX0,y+40,"Grounded in: hushh-research/docs · hussh-dev-platform (PCHP spec v1.1) · hushh-ria-intelligence-api · UCP (ucp.dev) · AP2 (ap2-protocol.org). Status is honest, not aspirational.",13.5,FAINT)

    S.append("</g></svg>")
    suffix=f"{theme_name}.public" if public else theme_name
    out=f"/Users/kushaltrivedi/Documents/GitHub/hushh-research/hussh-mega-map.{suffix}.svg"
    svg_str="\n".join(S)
    # round long float coords so geometry digit-runs can't trip the wiki credit_card scan
    svg_str=re.sub(r'(\d+\.\d{3,})', lambda m: f"{float(m.group(1)):.2f}", svg_str)
    open(out,"w").write(svg_str)
    print(suffix,"->",out,CW,CH,"layers",len(LAYERS),"flows",len(FLOWS),"gloss",len(GLOSS))
    return CW,CH

render("dark")
render("light")
render("dark", public=True)
render("light", public=True)
