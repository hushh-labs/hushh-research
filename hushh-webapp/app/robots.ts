import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard/", "/profile/", "/consents/"],
    },
    sitemap: "https://hushh.ai/sitemap.xml",
  };
}
