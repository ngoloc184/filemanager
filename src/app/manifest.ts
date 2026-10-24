import type { MetadataRoute } from "next";
import { APP_NAME } from "@/components/brand/logo";

// Installable web app: on iPhone, notifications only work once the site has
// been added to the Home Screen (iOS 16.4+).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Upload, organize and share files, and chat in real time.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#111220",
    theme_color: "#111220",
    icons: [
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
