// next.config.js
/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
    ],
    // Or: domains: ["placehold.co"],
  },
  productionBrowserSourceMaps: false,
};

module.exports = nextConfig;
