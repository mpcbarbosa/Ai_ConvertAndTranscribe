/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['fluent-ffmpeg'],
    serverActions: {
      bodySizeLimit: '500mb',
    },
  },
  output: 'standalone',
  api: {
    bodyParser: {
      sizeLimit: '500mb',
    },
    responseLimit: false,
  },
};

module.exports = nextConfig;
