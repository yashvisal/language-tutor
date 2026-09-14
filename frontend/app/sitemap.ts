import type { MetadataRoute } from "next"

/**
 * The three pages a stranger can read without an account. Everything else is
 * behind sign-in and is disallowed in `robots.ts`.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://lengua.chat", changeFrequency: "weekly", priority: 1 },
    {
      url: "https://lengua.chat/terms",
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: "https://lengua.chat/privacy",
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ]
}
