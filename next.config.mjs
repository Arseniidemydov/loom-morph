/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'playwright',
      'playwright-extra',
      'puppeteer-extra-plugin',
      'puppeteer-extra-plugin-stealth',
      'clone-deep',
      'merge-deep',
    ],
  },
};
export default nextConfig;
