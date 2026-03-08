/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg'],
  },
  output: 'standalone',
};

module.exports = nextConfig;
