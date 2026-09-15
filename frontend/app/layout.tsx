import type { Metadata, Viewport } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import { shadcn } from "@clerk/ui/themes"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ConvexClientProvider } from "@/components/convex-client-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

const DESCRIPTION =
  "A live language tutor that keeps the conversation going. Your words appear as you speak them, and after your turn settles you see what you should have said."

/**
 * What a link to lengua.chat becomes when someone pastes it.
 *
 * `metadataBase` is what makes every relative URL below (the canonical `/`,
 * the generated `opengraph-image`) resolve to the real host rather than
 * `localhost` in a preview build.
 *
 * The tab says "lengua" on every page, nothing more: no "Home · lengua", no
 * tagline on the landing (Yash, 2026-09-14, first look at the live domain).
 * So there is no title template and no page sets a title of its own. The
 * descriptive line stays on the Open Graph and Twitter cards, where it is the
 * text a pasted link shows, not a tab.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://lengua.chat"),
  applicationName: "lengua",
  title: "lengua",
  description: DESCRIPTION,
  openGraph: {
    siteName: "lengua",
    title: "lengua — practice languages, uninterrupted",
    description: DESCRIPTION,
    type: "website",
    locale: "en_US",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "lengua — practice languages, uninterrupted",
    description: DESCRIPTION,
  },
}

/**
 * The browser chrome follows the page. Both values are `--background` from
 * `globals.css`: `oklch(1 0 0)` is white, and the dark theme's
 * `oklch(0.145 0 0)` is `#0a0a0a`. Without both, a phone paints its address
 * bar white above a black page.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable,
        // In-page anchors glide instead of jumping (the landing's "How it
        // works", Yash, 2026-09-13). The one programmatic scroll in the app
        // already asks for smooth; reduced motion keeps the jump.
        "motion-safe:scroll-smooth"
      )}
    >
      <body>
        {/* Clerk's shadcn theme reads the app's CSS variables, so its modals
            track light/dark without a second theme source of truth. */}
        <ClerkProvider appearance={{ theme: shadcn }}>
          <ConvexClientProvider>
            <ThemeProvider>
              <TooltipProvider>{children}</TooltipProvider>
            </ThemeProvider>
          </ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  )
}
