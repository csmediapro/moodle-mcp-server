/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow reading the server build output from ../server/dist
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
};

module.exports = nextConfig;
