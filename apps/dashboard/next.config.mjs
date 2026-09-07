/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API URL is read in the browser, so it must be inlined at build time.
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000' },
};

export default nextConfig;
