import { ImageResponse } from "next/og"

/**
 * What a pasted lengua.chat link looks like in a message.
 *
 * The landing page in one frame: white, the orb, the sentence the hero opens
 * with, the wordmark and the domain underneath. Light theme only — every
 * platform that unfurls a link paints the card on its own background, and a
 * card that tracks the reader's theme is not a thing OG images can do.
 *
 * No font is loaded: `ImageResponse` in this version of Next already renders
 * with Geist (`next/dist/compiled/@vercel/og/Geist-Regular.ttf` is its
 * built-in family), which is the app's own typeface, so shipping a second
 * copy of it would only spend bundle for the same glyphs. That leaves one
 * weight, so the headline gets its emphasis from size rather than boldness.
 */

export const alt =
  "lengua — Your next language, out loud."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#ffffff",
          color: "#0a0a0a",
        }}
      >
        {/* The Aura at rest, the same mark as the favicon. */}
        <div
          style={{
            width: 132,
            height: 132,
            borderRadius: 132,
            backgroundImage:
              "radial-gradient(circle at 38% 32%, #93c5fd 0%, #60a5fa 45%, #3b82f6 100%)",
            boxShadow: "0 0 90px 30px rgba(59, 130, 246, 0.18)",
          }}
        />

        <div
          style={{
            marginTop: 64,
            fontSize: 76,
            letterSpacing: "-0.03em",
            textAlign: "center",
          }}
        >
          Your next language, out loud.
        </div>

        <div
          style={{
            marginTop: 56,
            display: "flex",
            alignItems: "center",
            fontSize: 26,
            color: "#737373",
          }}
        >
          <span style={{ color: "#0a0a0a" }}>lengua</span>
          <span style={{ marginLeft: 16, marginRight: 16 }}>·</span>
          <span>lengua.chat</span>
        </div>
      </div>
    ),
    { ...size }
  )
}
