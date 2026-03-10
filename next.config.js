/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg'],
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  output: 'standalone',
};

module.exports = nextConfig;
