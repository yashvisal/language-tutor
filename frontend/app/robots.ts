import type { MetadataRoute } from "next"

/**
 * What a crawler may index: the landing and the legal pages, and nothing
 * behind the sign-in. `/home` and `/session` need an account and a balance,
 * `/design-inspo` is the internal playground, `/api` is not for readers, and
 * an indexed `/sign-in` only competes with the page that explains the product.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/home",
        "/session",
        "/design-inspo",
        "/api",
        "/sign-in",
        "/sign-up",
      ],
    },
    sitemap: "https://lengua.chat/sitemap.xml",
  }
}
