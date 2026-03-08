/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},
  serverExternalPackages: ['fluent-ffmpeg'],
  output: 'standalone',
};

module.exports = nextConfig;
