import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Gold Jewellery Workspace",
    short_name: "Gold",
    description: "Gold rates, savings schemes and jewellery shop management.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f7f2",
    theme_color: "#194b33",
    lang: "en-IN",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }]
  };
}
