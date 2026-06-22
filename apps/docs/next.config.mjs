/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // Resolve and transpile workspace packages so subpath exports resolve
  // correctly when Next follows client-component imports from the server.
  transpilePackages: ['@thaddeus.run/store', '@thaddeus.run/theme'],
};

export default nextConfig;
