import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // URL corta para descargar el APK desde la tele (app Downloader): <tu-app>.vercel.app/apk
      {
        source: "/apk",
        destination: "https://github.com/victorodri/que-vemos-tv/releases/latest/download/que-vemos-tv.apk",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
