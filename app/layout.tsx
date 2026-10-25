import type { Metadata, Viewport } from "next";
import "./globals.css";

const BOOT_THEME_SCRIPT = `(()=>{const doc=document.documentElement,started=performance.now(),validMode=v=>v==='light'||v==='dark'||v==='system'||v==='time',validColor=v=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v);let userId=null,prefs=null;try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key||!key.startsWith('sb-')||!key.endsWith('-auth-token'))continue;const value=JSON.parse(localStorage.getItem(key)||'null');const user=value?.user||value?.currentSession?.user||value?.session?.user;const id=user?.id;if(typeof id==='string'&&id){userId=id;break;}}if(userId){const raw=localStorage.getItem('folio-theme-preference-v1:'+userId);if(raw)prefs=JSON.parse(raw);}}catch{}const hasCachedPreference=!!prefs&&validMode(prefs.themeMode),mode=hasCachedPreference?prefs.themeMode:'system',color=validColor(prefs?.themeColor)?prefs.themeColor:'#0F5132',hour=new Date().getHours(),dark=mode==='dark'||(mode==='time'?(hour<7||hour>=19):mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches),appearance=dark?'dark':'light',background=dark?'#050505':'#f6f7f5';doc.dataset.folioTheme=appearance;doc.style.colorScheme=appearance;doc.style.backgroundColor=background;doc.classList.add('appearance-'+appearance);const root=document.querySelector('#__next')||document.body;if(root)root.style.backgroundColor=background;let meta=document.querySelector('meta[name="theme-color"]');if(!meta){meta=document.createElement('meta');meta.name='theme-color';document.head.append(meta);}meta.content=background;window.__folioBootTheme={userId,hasCachedPreference,mode,appearance,color,startedAt:started};performance.mark('folio:theme-resolved');window.__folioMarkStartup=(stage)=>{if(!['session_restore_started','session_restored','session_expired','dashboard_iframe_loaded','shell_rendered','cached_snapshot_available','first_meaningful_content','fresh_state_committed','agent_refresh_completed'].includes(stage))return;performance.mark('folio:'+stage);const timings=window.__folioStartupTimings||(window.__folioStartupTimings=[]);if(timings.some(entry=>entry.stage===stage))return;const entry={stage,ms:Math.round(performance.now()-started)};timings.push(entry);console.debug('[Folio startup]',stage,entry.ms+'ms');};window.__folioStartupTimings=[{stage:'boot_started',ms:0},{stage:'theme_resolved',ms:Math.round(performance.now()-started)}];})();`;

export const metadata: Metadata = {
  title: "Folio",
  description: "Private household finances, budgets, accounts, and investments.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Folio", statusBarStyle: "black" },
  themeColor: "#050505",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }, { url: "/brand/folio-icon-32.png", sizes: "32x32", type: "image/png" }, { url: "/brand/folio-icon-16.png", sizes: "16x16", type: "image/png" }],
    shortcut: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  // Keep standalone iPhone layout sizing tied to the physical device height.
  height: "device-height",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#050505" />
        <meta name="folio-build-id" content={process.env.NEXT_PUBLIC_FOLIO_BUILD_ID || "development"} />
        <meta name="folio-api-generation" content={process.env.NEXT_PUBLIC_FOLIO_API_GENERATION || "1"} />
        <script dangerouslySetInnerHTML={{ __html: BOOT_THEME_SCRIPT }} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
